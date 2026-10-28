import sys
import cv2
import json
import os
import numpy as np

def verify_face_in_render(video_path, cascade_path):
    if not os.path.exists(video_path):
        return {"error": "Video file not found", "face_detected": False}
    if not os.path.exists(cascade_path):
        return {"error": "Cascade classifier XML file not found", "face_detected": False}

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": "Could not open video file", "face_detected": False}

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    if total_frames <= 0 or width <= 0 or height <= 0:
        cap.release()
        return {"error": "Invalid video dimensions or frame count", "face_detected": False}

    # Load classifiers
    try:
        cascade_detector = cv2.CascadeClassifier(cascade_path)
    except Exception as e:
        cap.release()
        return {"error": f"Failed to load Haar Cascade: {str(e)}", "face_detected": False}

    # Load eye cascade for eye detection check
    eye_cascade = None
    eye_cascade_path = os.path.join(os.path.dirname(cascade_path), "haarcascade_eye.xml")
    if not os.path.exists(eye_cascade_path):
        # Try OpenCV's built-in path
        cv2_data = getattr(cv2, 'data', None)
        if cv2_data:
            eye_cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_eye.xml")
    if os.path.exists(eye_cascade_path):
        eye_cascade = cv2.CascadeClassifier(eye_cascade_path)
        sys.stderr.write("[VerifyFace] Eye cascade loaded.\n")

    # Try MediaPipe
    mp_detector = None
    try:
        model_dir = os.path.dirname(cascade_path)
        model_path = os.path.join(model_dir, "face_detector.tflite")
        if os.path.exists(model_path):
            import mediapipe as mp
            from mediapipe.tasks import python
            from mediapipe.tasks.python import vision
            base_options = python.BaseOptions(model_asset_path=model_path)
            options = vision.FaceDetectorOptions(base_options=base_options, min_detection_confidence=0.35)
            mp_detector = vision.FaceDetector.create_from_options(options)
            sys.stderr.write("[VerifyFace] MediaPipe face detector initialized.\n")
    except Exception as e:
        sys.stderr.write(f"[VerifyFace] MediaPipe init failed/skipped: {str(e)}\n")

    # ================================================================
    # PASS 1: Sample 10 frames, detect faces, collect crops + full ROIs
    # ================================================================
    num_samples = 10
    frame_indices = [int(total_frames * (i / (num_samples + 1))) for i in range(1, num_samples + 1)]
    
    checked_frames_count = 0
    detections_log = []
    detected_faces = []
    facecam_rois = []  # Store full facecam ROI for background checks

    crop_h = int(height * 0.45)

    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if not ret:
            continue
        
        checked_frames_count += 1
        roi = frame[0:crop_h, 0:width]
        facecam_rois.append({"frame_idx": idx, "roi": roi.copy()})
        
        face_found = False
        bbox = None
        
        if mp_detector:
            try:
                rgb_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_roi)
                detection_result = mp_detector.detect(mp_image)
                if detection_result.detections:
                    d = detection_result.detections[0]
                    bbox = (int(d.bounding_box.origin_x), int(d.bounding_box.origin_y),
                            int(d.bounding_box.width), int(d.bounding_box.height))
                    face_found = True
                    score = d.categories[0].score if d.categories else 0.8
                    detections_log.append(f"Frame {idx}: Face via MediaPipe (conf: {score:.2f})")
            except Exception as e:
                sys.stderr.write(f"[VerifyFace] MediaPipe error frame {idx}: {str(e)}\n")
        
        if not face_found and cascade_detector:
            try:
                gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                faces = cascade_detector.detectMultiScale(gray_roi, 1.1, 5, minSize=(60, 60))
                if len(faces) > 0:
                    bbox = tuple(int(x) for x in faces[0])
                    face_found = True
                    detections_log.append(f"Frame {idx}: Face via Haar Cascade")
            except Exception as e:
                sys.stderr.write(f"[VerifyFace] Haar error frame {idx}: {str(e)}\n")
                
        if face_found and bbox is not None:
            x, y, w, h = bbox
            x1, y1 = max(0, x), max(0, y)
            x2, y2 = min(width, x + w), min(crop_h, y + h)
            face_crop_color = roi[y1:y2, x1:x2]
            if face_crop_color.size > 0:
                gray_crop = cv2.cvtColor(face_crop_color, cv2.COLOR_BGR2GRAY)
                resized_gray = cv2.resize(gray_crop, (64, 64))
                resized_color = cv2.resize(face_crop_color, (64, 64))
                detected_faces.append({
                    "frame_idx": idx,
                    "bbox": bbox,
                    "crop": resized_gray,
                    "crop_color": resized_color,
                    "roi_gray": cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                })

    # ================================================================
    # CHECK 1: Face detection count (basic presence)
    # ================================================================
    min_required = max(2, int(checked_frames_count * 0.20))
    check1_passed = len(detected_faces) >= min_required
    detections_log.append(f"[Check 1] Face detection: {len(detected_faces)}/{checked_frames_count} frames (need {min_required}) {'PASS' if check1_passed else 'FAIL'}")

    # ================================================================
    # CHECK 2: Static graphic filter (spatial clustering + pixel diff)
    # ================================================================
    clusters = []
    for d in detected_faces:
        x, y, w, h = d["bbox"]
        added = False
        for cluster in clusters:
            ref_x, ref_y, _, _ = cluster[0]["bbox"]
            if abs(x - ref_x) < 25 and abs(y - ref_y) < 25:
                cluster.append(d)
                added = True
                break
        if not added:
            clusters.append([d])

    valid_detections = 0
    for cluster in clusters:
        if len(cluster) >= 2:
            diffs = []
            for i in range(len(cluster) - 1):
                diff = cv2.absdiff(cluster[i]["crop"], cluster[i+1]["crop"])
                diffs.append(float(np.mean(diff)))
            avg_diff = float(np.mean(diffs))
            xs = [c["bbox"][0] for c in cluster]
            ys = [c["bbox"][1] for c in cluster]
            if not (float(np.std(xs)) < 2.0 and float(np.std(ys)) < 2.0 and avg_diff < 3.0):
                valid_detections += len(cluster)
        else:
            valid_detections += len(cluster)

    check2_passed = valid_detections >= min_required
    detections_log.append(f"[Check 2] Static filter: {valid_detections} valid (not static) {'PASS' if check2_passed else 'FAIL'}")

    # ================================================================
    # CHECK 3: Motion verification (pixel diff + optical flow)
    # ================================================================
    motion_checks = 0
    motion_passed = 0
    motion_scores = []
    frame_gap = max(1, int(fps * 0.3))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    for sample_idx in frame_indices:
        idx_a = sample_idx
        idx_b = min(sample_idx + frame_gap, total_frames - 1)
        if idx_a >= total_frames or idx_b >= total_frames or idx_a == idx_b:
            continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx_a)
        ret_a, frame_a = cap.read()
        if not ret_a: continue
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx_b)
        ret_b, frame_b = cap.read()
        if not ret_b: continue

        motion_checks += 1
        gray_a = cv2.cvtColor(frame_a[0:crop_h, 0:width], cv2.COLOR_BGR2GRAY)
        gray_b = cv2.cvtColor(frame_b[0:crop_h, 0:width], cv2.COLOR_BGR2GRAY)
        mean_diff = float(np.mean(cv2.absdiff(gray_a, gray_b)))
        try:
            flow = cv2.calcOpticalFlowFarneback(gray_a, gray_b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
            mean_flow = float(np.mean(mag))
        except:
            mean_flow = 0.0
        score = mean_diff + (mean_flow * 10.0)
        motion_scores.append(score)
        if score > 2.0:
            motion_passed += 1

    check3_passed = motion_passed >= max(2, int(motion_checks * 0.40)) if motion_checks > 0 else False
    detections_log.append(f"[Check 3] Motion: {motion_passed}/{motion_checks} passed {'PASS' if check3_passed else 'FAIL'}")

    # ================================================================
    # CHECK 4: Skin tone verification
    # ================================================================
    skin_passed = 0
    for d in detected_faces:
        hsv = cv2.cvtColor(d["crop_color"], cv2.COLOR_BGR2HSV)
        m1 = cv2.inRange(hsv, np.array([0, 30, 60]), np.array([25, 180, 255]))
        m2 = cv2.inRange(hsv, np.array([160, 30, 60]), np.array([180, 180, 255]))
        ratio = float(np.count_nonzero(m1 | m2)) / float((m1 | m2).size) if (m1 | m2).size > 0 else 0.0
        if ratio >= 0.15:
            skin_passed += 1
    check4_passed = skin_passed >= max(1, int(len(detected_faces) * 0.40)) if detected_faces else False
    detections_log.append(f"[Check 4] Skin tone: {skin_passed}/{len(detected_faces)} passed {'PASS' if check4_passed else 'FAIL'}")

    # ================================================================
    # CHECK 5: Face size consistency
    # ================================================================
    sizes = [d["bbox"][2] * d["bbox"][3] for d in detected_faces]
    size_cv = 0.0
    if len(sizes) >= 3:
        size_cv = float(np.std(sizes)) / float(np.mean(sizes)) if np.mean(sizes) > 0 else 999.0
    check5_passed = size_cv < 0.40 if len(sizes) >= 3 else (len(sizes) > 0)
    detections_log.append(f"[Check 5] Size consistency: CV={size_cv:.3f} {'PASS' if check5_passed else 'FAIL'}")

    # ================================================================
    # CHECK 6: Position stability
    # ================================================================
    pos_std = 0.0
    if len(detected_faces) >= 3:
        cx = [d["bbox"][0] + d["bbox"][2] / 2.0 for d in detected_faces]
        cy = [d["bbox"][1] + d["bbox"][3] / 2.0 for d in detected_faces]
        pos_std = (float(np.std(cx)) + float(np.std(cy))) / 2.0
    check6_passed = pos_std < 50.0 if len(detected_faces) >= 3 else (len(detected_faces) > 0)
    detections_log.append(f"[Check 6] Position stability: std={pos_std:.1f}px {'PASS' if check6_passed else 'FAIL'}")

    # ================================================================
    # CHECK 7: Sharpness (Laplacian variance)
    # ================================================================
    sharp_passed = 0
    for d in detected_faces:
        var = float(cv2.Laplacian(d["crop"], cv2.CV_64F).var())
        if var >= 50.0:
            sharp_passed += 1
    check7_passed = sharp_passed >= max(1, int(len(detected_faces) * 0.50)) if detected_faces else False
    detections_log.append(f"[Check 7] Sharpness: {sharp_passed}/{len(detected_faces)} sharp {'PASS' if check7_passed else 'FAIL'}")

    # ================================================================
    # CHECK 8: Brightness range
    # ================================================================
    bright_passed = 0
    for d in detected_faces:
        mb = float(np.mean(d["crop"]))
        if 30.0 <= mb <= 240.0:
            bright_passed += 1
    check8_passed = bright_passed >= max(1, int(len(detected_faces) * 0.50)) if detected_faces else False
    detections_log.append(f"[Check 8] Brightness: {bright_passed}/{len(detected_faces)} good {'PASS' if check8_passed else 'FAIL'}")

    # ================================================================
    # CHECK 9: Color variety
    # ================================================================
    color_passed = 0
    for d in detected_faces:
        hsv = cv2.cvtColor(d["crop_color"], cv2.COLOR_BGR2HSV)
        sat_std = float(np.std(hsv[:, :, 1]))
        val_std = float(np.std(hsv[:, :, 2]))
        hue_hist = cv2.calcHist([hsv], [0], None, [18], [0, 180])
        hue_bins = int(np.count_nonzero(hue_hist > hsv.shape[0] * hsv.shape[1] * 0.01))
        if sat_std > 10.0 and val_std > 15.0 and hue_bins >= 3:
            color_passed += 1
    check9_passed = color_passed >= max(1, int(len(detected_faces) * 0.40)) if detected_faces else False
    detections_log.append(f"[Check 9] Color variety: {color_passed}/{len(detected_faces)} passed {'PASS' if check9_passed else 'FAIL'}")

    # ================================================================
    # CHECK 10: Temporal consistency (face in majority of frames)
    # ================================================================
    det_rate = len(detected_faces) / float(checked_frames_count) if checked_frames_count > 0 else 0.0
    check10_passed = det_rate >= 0.50
    detections_log.append(f"[Check 10] Temporal: {det_rate:.0%} detection rate {'PASS' if check10_passed else 'FAIL'}")

    # ================================================================
    # CHECK 11: Eye detection within face region
    # A real face should have detectable eyes in some frames
    # ================================================================
    eye_found_count = 0
    if eye_cascade is not None:
        for d in detected_faces:
            eyes = eye_cascade.detectMultiScale(d["crop"], 1.1, 3, minSize=(8, 8))
            if len(eyes) >= 1:
                eye_found_count += 1
    else:
        eye_found_count = len(detected_faces)  # Skip if no eye cascade available
    check11_passed = eye_found_count >= max(1, int(len(detected_faces) * 0.30)) if detected_faces else False
    detections_log.append(f"[Check 11] Eye detection: {eye_found_count}/{len(detected_faces)} have eyes {'PASS' if check11_passed else 'FAIL'}")

    # ================================================================
    # CHECK 12: Face aspect ratio (real faces are taller than wide or roughly square)
    # ================================================================
    aspect_ok = 0
    for d in detected_faces:
        _, _, fw, fh = d["bbox"]
        ar = fw / float(fh) if fh > 0 else 0.0
        # Real face aspect ratio typically between 0.55 and 1.2
        if 0.55 <= ar <= 1.2:
            aspect_ok += 1
    check12_passed = aspect_ok >= max(1, int(len(detected_faces) * 0.50)) if detected_faces else False
    detections_log.append(f"[Check 12] Face aspect ratio: {aspect_ok}/{len(detected_faces)} normal {'PASS' if check12_passed else 'FAIL'}")

    # ================================================================
    # CHECK 13: Face-to-facecam-region ratio
    # Face should be a reasonable portion of the facecam area (not tiny, not filling everything)
    # ================================================================
    ratio_ok = 0
    facecam_area = crop_h * width
    for d in detected_faces:
        _, _, fw, fh = d["bbox"]
        face_area = fw * fh
        area_ratio = face_area / float(facecam_area) if facecam_area > 0 else 0.0
        # Face should be between 2% and 60% of the facecam region
        if 0.02 <= area_ratio <= 0.60:
            ratio_ok += 1
    check13_passed = ratio_ok >= max(1, int(len(detected_faces) * 0.50)) if detected_faces else False
    detections_log.append(f"[Check 13] Face-to-region ratio: {ratio_ok}/{len(detected_faces)} reasonable {'PASS' if check13_passed else 'FAIL'}")

    # ================================================================
    # CHECK 14: Background consistency in facecam region
    # The area around the face (background) should stay mostly the same
    # (streamer's room doesn't change). Wild background changes = not a real facecam.
    # ================================================================
    bg_consistent = True
    if len(facecam_rois) >= 3:
        bg_diffs = []
        for i in range(len(facecam_rois) - 1):
            r1 = cv2.cvtColor(cv2.resize(facecam_rois[i]["roi"], (128, 64)), cv2.COLOR_BGR2GRAY)
            r2 = cv2.cvtColor(cv2.resize(facecam_rois[i+1]["roi"], (128, 64)), cv2.COLOR_BGR2GRAY)
            bg_diffs.append(float(np.mean(cv2.absdiff(r1, r2))))
        avg_bg_diff = float(np.mean(bg_diffs))
        max_bg_diff = float(np.max(bg_diffs))
        # If max background change is huge (>40), there are scene cuts = not stable facecam
        bg_consistent = max_bg_diff < 40.0
        detections_log.append(f"[Check 14] Background: avg_diff={avg_bg_diff:.1f} max_diff={max_bg_diff:.1f} {'PASS' if bg_consistent else 'FAIL'}")
    check14_passed = bg_consistent

    # ================================================================
    # CHECK 15: Edge structure in face (real faces have distinct edge patterns)
    # Canny edge density should be within a realistic range
    # ================================================================
    edge_ok = 0
    for d in detected_faces:
        edges = cv2.Canny(d["crop"], 50, 150)
        edge_density = float(np.count_nonzero(edges)) / float(edges.size) if edges.size > 0 else 0.0
        # Real faces: 5-40% edge density (not too smooth like a solid graphic, not too noisy)
        if 0.05 <= edge_density <= 0.40:
            edge_ok += 1
    check15_passed = edge_ok >= max(1, int(len(detected_faces) * 0.40)) if detected_faces else False
    detections_log.append(f"[Check 15] Edge structure: {edge_ok}/{len(detected_faces)} realistic edges {'PASS' if check15_passed else 'FAIL'}")

    # ================================================================
    # CHECK 16: Texture complexity (Local Binary Pattern variance)
    # Real skin has complex micro-texture. Flat graphics/logos are smoother.
    # ================================================================
    texture_ok = 0
    for d in detected_faces:
        gray = d["crop"]
        # Simple LBP approximation: compare each pixel with its 8 neighbors
        # Use Sobel gradient magnitude as proxy for texture complexity
        sx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
        sy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
        gradient_mag = np.sqrt(sx**2 + sy**2)
        texture_score = float(np.std(gradient_mag))
        # Real faces: texture score > 15 (has detail), < 200 (not pure noise)
        if 15.0 < texture_score < 200.0:
            texture_ok += 1
    check16_passed = texture_ok >= max(1, int(len(detected_faces) * 0.40)) if detected_faces else False
    detections_log.append(f"[Check 16] Texture complexity: {texture_ok}/{len(detected_faces)} realistic texture {'PASS' if check16_passed else 'FAIL'}")

    # ================================================================
    # CHECK 17: Micro-expression detection (eye region pixel changes between frames)
    # Real faces blink and show micro-expressions. Compare the upper-third of the face crop.
    # ================================================================
    micro_expr_changes = 0
    if len(detected_faces) >= 2:
        for i in range(len(detected_faces) - 1):
            # Upper third of face = eye/forehead region
            eye_region_a = detected_faces[i]["crop"][0:22, :]  # top 1/3 of 64px
            eye_region_b = detected_faces[i+1]["crop"][0:22, :]
            eye_diff = float(np.mean(cv2.absdiff(eye_region_a, eye_region_b)))
            if eye_diff > 3.0:  # More than compression noise
                micro_expr_changes += 1
    micro_expr_total = max(1, len(detected_faces) - 1)
    check17_passed = micro_expr_changes >= max(1, int(micro_expr_total * 0.30)) if len(detected_faces) >= 2 else False
    detections_log.append(f"[Check 17] Micro-expressions: {micro_expr_changes}/{micro_expr_total} eye region changes {'PASS' if check17_passed else 'FAIL'}")

    # ================================================================
    # CHECK 18: Scene cut detection in facecam
    # Sudden large pixel jumps between consecutive sampled frames = scene cuts/replays
    # A real facecam should have 0 scene cuts.
    # ================================================================
    scene_cuts = 0
    if len(facecam_rois) >= 2:
        for i in range(len(facecam_rois) - 1):
            r1 = cv2.cvtColor(cv2.resize(facecam_rois[i]["roi"], (64, 32)), cv2.COLOR_BGR2GRAY)
            r2 = cv2.cvtColor(cv2.resize(facecam_rois[i+1]["roi"], (64, 32)), cv2.COLOR_BGR2GRAY)
            frame_diff = float(np.mean(cv2.absdiff(r1, r2)))
            if frame_diff > 35.0:  # Massive sudden change = scene cut
                scene_cuts += 1
    check18_passed = scene_cuts <= 1  # Allow at most 1 scene cut (stream overlay change)
    detections_log.append(f"[Check 18] Scene cuts: {scene_cuts} detected {'PASS' if check18_passed else 'FAIL'}")

    # ================================================================
    # CHECK 19: Color temperature consistency
    # Real webcam maintains consistent white balance. Replays/compilations shift wildly.
    # ================================================================
    color_temp_ok = True
    if len(detected_faces) >= 3:
        avg_blues = [float(np.mean(d["crop_color"][:, :, 0])) for d in detected_faces]
        avg_reds = [float(np.mean(d["crop_color"][:, :, 2])) for d in detected_faces]
        blue_std = float(np.std(avg_blues))
        red_std = float(np.std(avg_reds))
        # Color channels should stay within ~15 std deviation
        color_temp_ok = blue_std < 15.0 and red_std < 15.0
        detections_log.append(f"[Check 19] Color temp: blue_std={blue_std:.1f} red_std={red_std:.1f} {'PASS' if color_temp_ok else 'FAIL'}")
    check19_passed = color_temp_ok

    # ================================================================
    # CHECK 20: Face symmetry check
    # Human faces have approximate bilateral symmetry. Logos/text may not.
    # ================================================================
    symmetry_ok = 0
    for d in detected_faces:
        face_gray = d["crop"]
        left_half = face_gray[:, :32]
        right_half = cv2.flip(face_gray[:, 32:], 1)
        sym_diff = float(np.mean(cv2.absdiff(left_half, right_half)))
        # Real faces: symmetry diff between 5 and 35 (not perfectly symmetric like a logo,
        # but not wildly asymmetric like random graphics)
        if 5.0 <= sym_diff <= 35.0:
            symmetry_ok += 1
    check20_passed = symmetry_ok >= max(1, int(len(detected_faces) * 0.30)) if detected_faces else False
    detections_log.append(f"[Check 20] Face symmetry: {symmetry_ok}/{len(detected_faces)} natural symmetry {'PASS' if check20_passed else 'FAIL'}")

    cap.release()

    # ================================================================
    # FINAL DECISION: Weighted scoring across all 20 checks
    # ================================================================
    all_checks = {
        "01_face_detection":       {"passed": check1_passed,  "weight": 3, "critical": True},
        "02_static_filter":        {"passed": check2_passed,  "weight": 2, "critical": False},
        "03_motion":               {"passed": check3_passed,  "weight": 3, "critical": True},
        "04_skin_tone":            {"passed": check4_passed,  "weight": 2, "critical": False},
        "05_size_consistency":     {"passed": check5_passed,  "weight": 1, "critical": False},
        "06_position_stability":   {"passed": check6_passed,  "weight": 1, "critical": False},
        "07_sharpness":            {"passed": check7_passed,  "weight": 1, "critical": False},
        "08_brightness":           {"passed": check8_passed,  "weight": 1, "critical": False},
        "09_color_variety":        {"passed": check9_passed,  "weight": 1, "critical": False},
        "10_temporal_consistency": {"passed": check10_passed, "weight": 2, "critical": False},
        "11_eye_detection":        {"passed": check11_passed, "weight": 2, "critical": False},
        "12_face_aspect_ratio":    {"passed": check12_passed, "weight": 1, "critical": False},
        "13_face_region_ratio":    {"passed": check13_passed, "weight": 1, "critical": False},
        "14_background_stable":    {"passed": check14_passed, "weight": 1, "critical": False},
        "15_edge_structure":       {"passed": check15_passed, "weight": 1, "critical": False},
        "16_texture_complexity":   {"passed": check16_passed, "weight": 1, "critical": False},
        "17_micro_expressions":    {"passed": check17_passed, "weight": 2, "critical": False},
        "18_no_scene_cuts":        {"passed": check18_passed, "weight": 2, "critical": False},
        "19_color_temp_stable":    {"passed": check19_passed, "weight": 1, "critical": False},
        "20_face_symmetry":        {"passed": check20_passed, "weight": 1, "critical": False},
    }

    total_weight = sum(c["weight"] for c in all_checks.values())
    passed_weight = sum(c["weight"] for c in all_checks.values() if c["passed"])
    score_pct = (passed_weight / total_weight * 100.0) if total_weight > 0 else 0.0

    # Critical: face detection + motion MUST pass
    critical_passed = all(c["passed"] for c in all_checks.values() if c.get("critical"))

    # Final: critical must pass AND overall score >= 55%
    face_detected = critical_passed and score_pct >= 55.0

    passed_count = sum(1 for c in all_checks.values() if c["passed"])
    total_count = len(all_checks)

    checks_summary = {k: v["passed"] for k, v in all_checks.items()}

    return {
        "face_detected": face_detected,
        "score_pct": round(score_pct, 1),
        "checks_passed": f"{passed_count}/{total_count}",
        "critical_passed": critical_passed,
        "checks": checks_summary,
        "face_frames": len(detected_faces),
        "total_checked": checked_frames_count,
        "motion_passed": motion_passed,
        "motion_checks": motion_checks,
        "avg_motion_score": round(float(np.mean(motion_scores)) if motion_scores else 0.0, 2),
        "detections": detections_log,
        "width": width,
        "height": height
    }

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: verify_face_in_render.py <video_path> <cascade_path>", "face_detected": False}))
        sys.exit(1)
        
    video_p = sys.argv[1]
    cascade_p = sys.argv[2]
    
    try:
        res = verify_face_in_render(video_p, cascade_p)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"error": f"Internal python exception: {str(e)}", "face_detected": False}))
        sys.exit(1)
