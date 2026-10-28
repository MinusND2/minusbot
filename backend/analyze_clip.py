import sys
import cv2
import json
import os
import numpy as np
import mediapipe as mp
import math

class TemporalEdgeDetector:
    """
    Computes accumulated Canny edges over multiple frames to isolate static boundaries.
    Gameplay contours blur out, while static webcam borders become extremely bright.
    """
    def __init__(self, width, height):
        self.width = width
        self.height = height

    def compute_accumulated_edges(self, frames, corners):
        """
        frames: list of loaded BGR frames.
        corners: list of (name, x1, y1, x2, y2) regions.
        Returns: dict of corner_name -> accumulated normalized edge map.
        """
        accumulated = {}
        for name, x1, y1, x2, y2 in corners:
            crop_w = x2 - x1
            crop_h = y2 - y1
            if crop_w <= 0 or crop_h <= 0:
                continue
            
            # Sum up Canny edge maps
            sum_edges = np.zeros((crop_h, crop_w), dtype=np.float32)
            for frame in frames:
                crop = frame[y1:y2, x1:x2]
                if crop.size == 0:
                    continue
                gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                blurred = cv2.GaussianBlur(gray, (5, 5), 0)
                edges = cv2.Canny(blurred, 30, 100)
                sum_edges += edges
            
            # Normalize to 0-255
            if len(frames) > 0:
                sum_edges = (sum_edges / len(frames)).astype(np.uint8)
            else:
                sum_edges = sum_edges.astype(np.uint8)
                
            accumulated[name] = sum_edges
        return accumulated

    def find_static_rectangles(self, accumulated_edges, corners):
        """
        Runs contour detection on accumulated edge maps to find rectangular candidates.
        """
        candidates = []
        for name, x1, y1, x2, y2 in corners:
            edge_map = accumulated_edges.get(name)
            if edge_map is None or edge_map.size == 0:
                continue
            
            # Dilate to join broken contours
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
            dilated = cv2.dilate(edge_map, kernel, iterations=1)
            
            contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            crop_w = x2 - x1
            crop_h = y2 - y1
            
            for contour in contours:
                area = cv2.contourArea(contour)
                # Filter out tiny noise and giant full-crop rectangles
                if area < (crop_w * crop_h) * 0.05 or area > (crop_w * crop_h) * 0.90:
                    continue
                
                # Bounding box
                rx, ry, rw, rh = cv2.boundingRect(contour)
                
                # Check aspect ratio and absolute size (webcams are typically 4:3 or 16:9, and <= 35% of screen width/height)
                aspect = rw / rh
                if 0.5 <= aspect <= 2.2 and rw <= self.width * 0.35 and rh <= self.height * 0.35:
                    candidates.append({
                        "corner": name,
                        "x": x1 + rx,
                        "y": y1 + ry,
                        "w": rw,
                        "h": rh,
                        "aspect_ratio": aspect,
                        "edge_density": float(area / (rw * rh))
                    })
        return candidates

class MotionAnalyzer:
    """
    Analyzes temporal motion (variance of pixel intensity and frame-to-frame deltas)
    within candidate boxes to distinguish live video feeds from static UI overlays and furniture.
    """
    def __init__(self):
        pass

    def analyze_motion(self, frames, candidates):
        """
        Computes standard deviation of pixel intensities and frame-to-frame absolute deltas
        across frames inside each candidate box to verify temporal motion.
        """
        results = []
        for cand in candidates:
            cx, cy, cw, ch = cand["x"], cand["y"], cand["w"], cand["h"]
            
            pixel_means = []
            deltas = []
            
            prev_gray = None
            for frame in frames:
                roi = frame[cy:cy+ch, cx:cx+cw]
                if roi.size == 0:
                    continue
                gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                pixel_means.append(gray_roi.mean())
                
                if prev_gray is not None:
                    diff = cv2.absdiff(gray_roi, prev_gray)
                    deltas.append(diff.mean())
                prev_gray = gray_roi
                
            if len(pixel_means) < 2:
                cand["motion_score"] = 0.0
                cand["mean_delta_motion"] = 0.0
                cand["is_static_overlay"] = True
                results.append(cand)
                continue
            
            # Standard deviation of average intensity over time
            std_dev = float(np.std(pixel_means))
            
            # Mean frame-to-frame absolute delta
            mean_delta_motion = float(np.mean(deltas)) if deltas else 0.0
            
            # Normalize motion score based on frame difference (mean delta of 4.5 represents solid video motion)
            motion_score = min(1.0, mean_delta_motion / 4.5)
            
            # If average frame-to-frame difference is extremely low, it's static graphics/HUD/furniture
            cand["motion_score"] = motion_score
            cand["mean_delta_motion"] = mean_delta_motion
            cand["is_static_overlay"] = bool(mean_delta_motion < 1.3)
            cand["intensity_std_dev"] = std_dev
            results.append(cand)
            
        return results

class FaceVerifier:
    """
    Uses MediaPipe Tasks Face Detector model or Haar Cascades to check if a face exists in candidate regions.
    Also uses Haar Cascades to detect human upperbody presence for the multi-layer decision scoring.
    """
    def __init__(self, cascade_path):
        self.cascade_path = cascade_path
        self.mp_detector = None
        self.upperbody_cascade = None
        try:
            # Try initializing MediaPipe Tasks Face Detector
            model_dir = os.path.dirname(cascade_path)
            model_path = os.path.join(model_dir, "face_detector.tflite")
            if os.path.exists(model_path):
                from mediapipe.tasks import python
                from mediapipe.tasks.python import vision
                
                base_options = python.BaseOptions(model_asset_path=model_path)
                options = vision.FaceDetectorOptions(base_options=base_options, min_detection_confidence=0.35)
                self.mp_detector = vision.FaceDetector.create_from_options(options)
                sys.stderr.write("[FaceVerifier] MediaPipe Tasks Face Detector initialized successfully.\n")
            else:
                sys.stderr.write(f"[FaceVerifier] face_detector.tflite not found at {model_path}, using Haar Cascade.\n")
        except Exception as e:
            sys.stderr.write(f"[FaceVerifier] MediaPipe Tasks init failed ({e}), using Haar Cascade.\n")

        try:
            # Initialize OpenCV Upperbody Cascade
            ub_path = os.path.join(cv2.data.haarcascades, "haarcascade_upperbody.xml")
            self.upperbody_cascade = cv2.CascadeClassifier(ub_path)
            sys.stderr.write("[FaceVerifier] OpenCV Upperbody Cascade loaded successfully.\n")
        except Exception as e:
            sys.stderr.write(f"[FaceVerifier] OpenCV Upperbody Cascade load failed ({e}).\n")

    def verify_faces(self, frames, candidates):
        """
        Checks if a face is detected within candidate boundaries across frames.
        """
        cascade_detector = None
        try:
            cascade_detector = cv2.CascadeClassifier(self.cascade_path)
        except Exception as e:
            sys.stderr.write(f"[FaceVerifier] Failed to load Haar Cascade: {e}\n")

        for cand in candidates:
            cx, cy, cw, ch = cand["x"], cand["y"], cand["w"], cand["h"]
            face_detections = 0
            body_detections = 0
            total_face_confidence = 0.0
            max_rel_w = 0.0
            face_centers = []
            
            # To save performance, analyze a subset of frames for face presence
            sample_frames = frames[::max(1, len(frames)//5)]
            
            for frame in sample_frames:
                roi = frame[cy:cy+ch, cx:cx+cw]
                if roi.size == 0:
                    continue
                
                face_found = False
                face_score = 0.0
                face_w = 0.0
                fx_c = 0.0
                fy_c = 0.0
                
                # Try MediaPipe first
                if self.mp_detector:
                    try:
                        rgb_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
                        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_roi)
                        detection_result = self.mp_detector.detect(mp_image)
                        if detection_result.detections:
                            # Use first detected face
                            d = detection_result.detections[0]
                            face_found = True
                            face_score = d.categories[0].score if d.categories else 0.8
                            face_w = d.bounding_box.width
                            fx_c = d.bounding_box.origin_x + d.bounding_box.width / 2.0
                            fy_c = d.bounding_box.origin_y + d.bounding_box.height / 2.0
                            
                            # Skin tone check
                            bx = int(d.bounding_box.origin_x)
                            by = int(d.bounding_box.origin_y)
                            bw = int(d.bounding_box.width)
                            bh = int(d.bounding_box.height)
                            face_crop = roi[max(0, by):min(ch, by+bh), max(0, bx):min(cw, bx+bw)]
                            if face_crop.size > 0:
                                hsv = cv2.cvtColor(face_crop, cv2.COLOR_BGR2HSV)
                                mean_s = np.mean(hsv[:, :, 1])
                                if mean_s >= 10.0:  # Only verify skin if color image
                                    m1 = cv2.inRange(hsv, np.array([0, 20, 50]), np.array([25, 180, 255]))
                                    m2 = cv2.inRange(hsv, np.array([165, 20, 50]), np.array([180, 180, 255]))
                                    ratio = float(np.count_nonzero(m1 | m2)) / float(face_crop.size)
                                    if ratio < 0.10:
                                        face_found = False  # Reject false positive
                                        sys.stderr.write(f"[Skin Filter] Rejected face in {cand['corner']} (ratio={ratio:.2f})\n")
                    except Exception as e:
                        pass
                
                # Fallback to Haar Cascade only if MediaPipe is not available/initialized
                if not self.mp_detector and cascade_detector:
                    try:
                        gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                        faces = cascade_detector.detectMultiScale(gray_roi, 1.1, 6, minSize=(50, 50))
                        if len(faces) > 0:
                            face_found = True
                            face_score = 0.7
                            fx, fy, fw, fh = faces[0]
                            face_w = fw
                            fx_c = fx + fw / 2.0
                            fy_c = fy + fh / 2.0
                            
                            # Skin tone check
                            face_crop = roi[max(0, fy):min(ch, fy+fh), max(0, fx):min(cw, fx+fw)]
                            if face_crop.size > 0:
                                hsv = cv2.cvtColor(face_crop, cv2.COLOR_BGR2HSV)
                                mean_s = np.mean(hsv[:, :, 1])
                                if mean_s >= 10.0:  # Only verify skin if color image
                                    m1 = cv2.inRange(hsv, np.array([0, 20, 50]), np.array([25, 180, 255]))
                                    m2 = cv2.inRange(hsv, np.array([165, 20, 50]), np.array([180, 180, 255]))
                                    ratio = float(np.count_nonzero(m1 | m2)) / float(face_crop.size)
                                    if ratio < 0.10:
                                        face_found = False  # Reject false positive
                                        sys.stderr.write(f"[Skin Filter] Rejected Haar face in {cand['corner']} (ratio={ratio:.2f})\n")
                    except Exception as e:
                        pass
                
                if face_found:
                    face_detections += 1
                    total_face_confidence += face_score
                    max_rel_w = max(max_rel_w, float(face_w / cw))
                    face_centers.append((fx_c, fy_c))

                # Upperbody Detection
                if self.upperbody_cascade:
                    try:
                        gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                        bodies = self.upperbody_cascade.detectMultiScale(gray_roi, 1.1, 3, minSize=(40, 40))
                        if len(bodies) > 0:
                            body_detections += 1
                    except Exception as e:
                        pass
            
            # Calculate Stability Score
            if len(face_centers) >= 2:
                std_x = float(np.std([c[0] for c in face_centers]))
                std_y = float(np.std([c[1] for c in face_centers]))
                sys.stderr.write(f"[Stability Debug] {cand['corner']}: std_x={std_x:.2f}, std_y={std_y:.2f}, cw={cw}, ch={ch}, centers={face_centers}\n")
                if std_x == 0.0 and std_y == 0.0:
                    # Completely static (e.g. static graphic poster/logo with face pattern)
                    stability_score = 0.2
                elif std_x > cw * 0.25 or std_y > ch * 0.25:
                    # Jumping wildly (e.g. chat overlay scrolling or gameplay background shifts)
                    stability_score = 0.3
                else:
                    # Natural human micro-movements (breathing, speaking)
                    stability_score = 1.0
            elif len(face_centers) == 1:
                stability_score = 0.5
            else:
                stability_score = 0.0
                
            cand["face_ratio"] = float(face_detections / len(sample_frames)) if len(sample_frames) > 0 else 0.0
            cand["face_score"] = float(total_face_confidence / face_detections) if face_detections > 0 else 0.0
            cand["person_ratio"] = float(body_detections / len(sample_frames)) if len(sample_frames) > 0 else 0.0
            cand["max_face_relative_w"] = max_rel_w
            cand["stability_score"] = stability_score
            
        return candidates

class YoloVerifier:
    """
    Modular placeholder class for Phase 2 YOLOv11 integration.
    """
    def __init__(self):
        pass

    def verify(self, frames, candidates):
        """
        Placeholder: Will query custom trained YOLO model in Phase 2.
        """
        for cand in candidates:
            # Drop-in YOLO verification score here
            cand["yolo_score"] = 0.0
        return candidates

def analyze_video(video_path, cascade_path):
    if not os.path.exists(video_path):
        return {"error": "Video file not found", "layout": "blur-bg"}
    if not os.path.exists(cascade_path):
        return {"error": "Cascade classifier XML file not found", "layout": "blur-bg"}

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": "Could not open video file", "layout": "blur-bg"}

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    
    if total_frames <= 0 or width <= 0 or height <= 0:
        return {"error": "Invalid video dimensions or frame count", "layout": "blur-bg"}

    # Define a folder for visual debugging frames
    video_basename = os.path.splitext(os.path.basename(video_path))[0]
    clips_dir = os.path.dirname(video_path)
    debug_dir = os.path.join(clips_dir, "debug_frames", video_basename)
    os.makedirs(debug_dir, exist_ok=True)

    # Scan Regions: Cover corners, center areas, and centered top/bottom quadrants to catch Discord 3-person grid layouts
    corners = [
        ("TL", 0, 0, int(width * 0.52), int(height * 0.52)),
        ("TR", int(width * 0.48), 0, width, int(height * 0.52)),
        ("BL", 0, int(height * 0.48), int(width * 0.52), height),
        ("BR", int(width * 0.48), int(height * 0.48), width, height),
        ("TC", int(width * 0.23), 0, int(width * 0.77), int(height * 0.52)),
        ("BC", int(width * 0.23), int(height * 0.48), int(width * 0.77), height)
    ]

    # Load 1 frame per second of the video, capped at 30 frames, min 5 frames
    duration_sec = total_frames / fps
    num_samples = int(max(5, min(30, duration_sec)))
    frame_indices = [int(total_frames * (i / (num_samples + 1))) for i in range(1, num_samples + 1)]
    
    loaded_frames = []
    for idx in frame_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            loaded_frames.append(frame)
    cap.release()

    if not loaded_frames:
        return {"error": "Could not read any frames from video", "layout": "blur-bg", "candidates_debug": []}

    # --- Step 1: Temporal Edge Aggregation ---
    sys.stderr.write(f"[TEA] Computing accumulated edge maps over {len(loaded_frames)} frames...\n")
    ted = TemporalEdgeDetector(width, height)
    accumulated_edges = ted.compute_accumulated_edges(loaded_frames, corners)
    
    # Save the averaged edges debug map
    edge_canvas = np.zeros((height, width), dtype=np.uint8)
    for name, x1, y1, x2, y2 in corners:
        edge_map = accumulated_edges.get(name)
        if edge_map is not None:
            edge_canvas[y1:y2, x1:x2] = edge_map
    cv2.imwrite(os.path.join(debug_dir, "averaged_edges.jpg"), edge_canvas)
    
    # Find candidate rectangles based on static accumulated edge lines
    candidates = ted.find_static_rectangles(accumulated_edges, corners)
    sys.stderr.write(f"[TEA] Found {len(candidates)} static rectangle candidates.\n")

    # Always add the corner regions as fallback candidates to handle borderless webcams
    # when other static elements (like video players) are present.
    sys.stderr.write(f"[Fallback] Adding corner regions directly as candidate facecam boxes.\n")
    fallback_corners = [
        ("TL", 0, 0, int(width * 0.25), int(height * 0.25)),
        ("TR", int(width * 0.75), 0, width, int(height * 0.25)),
        ("BL", 0, int(height * 0.75), int(width * 0.25), height),
        ("BR", int(width * 0.75), int(height * 0.75), width, height),
        ("TC", int(width * 0.375), 0, int(width * 0.625), int(height * 0.25)),
        ("BC", int(width * 0.375), int(height * 0.75), int(width * 0.625), height)
    ]
    for name, x1, y1, x2, y2 in fallback_corners:
        cw = x2 - x1
        ch = y2 - y1
        aspect = cw / ch if ch > 0 else 1.0
        candidates.append({
            "corner": name,
            "x": x1,
            "y": y1,
            "w": cw,
            "h": ch,
            "aspect_ratio": aspect,
            "edge_density": 0.1,  # Low default since no edge-based detection
            "is_fallback": True
        })

    # --- Step 2: Motion Analysis ---
    motion_analyzer = MotionAnalyzer()
    candidates = motion_analyzer.analyze_motion(loaded_frames, candidates)

    # --- Step 3: Face Verification (Secondary score booster) ---
    face_verifier = FaceVerifier(cascade_path)
    candidates = face_verifier.verify_faces(loaded_frames, candidates)

    # --- Step 4: YOLO Verifier (Placeholder for Phase 2) ---
    yolo_verifier = YoloVerifier()
    candidates = yolo_verifier.verify(loaded_frames, candidates)

    # --- Step 5: Scoring Fusion & Decision ---
    valid_facecams = []
    candidates_debug = []
    
    for cand in candidates:
        cx, cy, cw, ch = cand["x"], cand["y"], cand["w"], cand["h"]
        cand_area_pct = (cw * ch) / (width * height)
        
        face_ratio = cand.get("face_ratio", 0.0)
        person_ratio = cand.get("person_ratio", 0.0)
        rel_face_w = cand.get("max_face_relative_w", 0.0)
        
        # 1. Face Detection Score (Max 30 Points)
        face_score_points = 0.0
        if face_ratio > 0.0:
            face_score_points = 10.0 + 20.0 * face_ratio

        # 2. Person Detection Score (Max 30 Points)
        person_score_points = 30.0 * person_ratio
        person_score_points = max(person_score_points, 20.0 * face_ratio)

        # 3. Temporal Analysis Score (Max 20 Points)
        stability_score = cand.get("stability_score", 0.0)
        motion_score = cand.get("motion_score", 0.0)
        temporal_score_points = 10.0 * stability_score + 10.0 * motion_score

        # 4. Pattern Analysis Score (Max 20 Points)
        corner_name = cand["corner"]
        if corner_name in ("TL", "TR", "BL", "BR"):
            position_points = 10.0
        elif corner_name in ("TC", "BC"):
            position_points = 5.0
        else:
            position_points = 2.0

        size_points = 5.0 if cand_area_pct <= 0.35 else 0.0

        aspect = cand["aspect_ratio"]
        aspect_diff = min(abs(1.33 - aspect), abs(1.77 - aspect), abs(1.0 - aspect))
        aspect_score = 1.0 - min(1.0, aspect_diff)
        aspect_points = 5.0 * aspect_score

        pattern_score_points = position_points + size_points + aspect_points

        # Total points (Max 100)
        total_score = face_score_points + person_score_points + temporal_score_points + pattern_score_points
        cand["confidence"] = float(total_score / 100.0)

        # Classify based on score
        if total_score >= 90.0:
            classification = "Sehr sichere Facecam"
        elif total_score >= 70.0:
            classification = "Wahrscheinliche Facecam"
        elif total_score >= 50.0:
            classification = "Unsicher"
        else:
            classification = "Verwerfen"

        # Evaluate rejection criteria
        discard_reason = None
        face_w_video_pct = rel_face_w * (cw / width)
        if cand_area_pct > 0.35 or (cw / width) > 0.35 or (ch / height) > 0.35:
            discard_reason = f"Candidate dimensions too large (w: {cw/width*100:.1f}%, h: {ch/height*100:.1f}%)"
        elif cw < width * 0.10 or ch < height * 0.10:
            discard_reason = f"Candidate dimensions too small (w: {cw/width*100:.1f}%, h: {ch/height*100:.1f}%)"
        elif cand.get("is_static_overlay", False):
            discard_reason = f"Too static (mean absolute delta: {cand.get('mean_delta_motion', 0.0):.2f})"
        elif face_ratio < 0.35 and person_ratio < 0.35:
            discard_reason = f"No face or person proof (face: {face_ratio:.2f}, person: {person_ratio:.2f})"
        elif rel_face_w > 0.0 and (rel_face_w < 0.12 or rel_face_w > 0.85):
            discard_reason = f"Face size proportion mismatch (rel_face_w: {rel_face_w:.2f})"
        elif face_w_video_pct > 0.0 and face_w_video_pct < 0.035:
            discard_reason = f"Face too tiny in video (face_w_video_pct: {face_w_video_pct*100:.1f}%)"
        elif total_score < 70.0:
            discard_reason = f"Score too low ({total_score:.1f}/100)"

        status = "Verwerfen" if discard_reason else classification

        # Record debug details
        debug_entry = {
            "corner": corner_name,
            "x": max(0, min(100, int((cx / width) * 100))),
            "y": max(0, min(100, int((cy / height) * 100))),
            "w": max(10, min(100, int((cw / width) * 100))),
            "h": max(10, min(100, int((ch / height) * 100))),
            "is_fallback": bool(cand.get("is_fallback", False)),
            "scores": {
                "face_detection": float(face_score_points),
                "person_detection": float(person_score_points),
                "temporal_analysis": float(temporal_score_points),
                "pattern_analysis": float(pattern_score_points),
                "total_score": float(total_score)
            },
            "status": status,
            "discard_reason": discard_reason
        }
        candidates_debug.append(debug_entry)

        # Accept if valid
        if not discard_reason:
            valid_facecams.append(cand)

    # Print detailed Debug Report to stderr
    sys.stderr.write("\n=== FACECAM CANDIDATE DEBUG REPORT ===\n")
    for dbg in candidates_debug:
        sys.stderr.write(f"Candidate {dbg['corner']} ({dbg['x']}%x, {dbg['y']}%y, {dbg['w']}%w, {dbg['h']}%h) [Fallback: {dbg['is_fallback']}]:\n"
                         f"  - Face Detection Score:   {dbg['scores']['face_detection']:.1f} / 30\n"
                         f"  - Person Detection Score: {dbg['scores']['person_detection']:.1f} / 30\n"
                         f"  - Movement Score:         {dbg['scores']['temporal_analysis']:.1f} / 20\n"
                         f"  - Position & Pattern Score: {dbg['scores']['pattern_analysis']:.1f} / 20\n"
                         f"  - Gesamtscore:            {dbg['scores']['total_score']:.1f} / 100\n"
                         f"  - Status:                 {dbg['status']}\n"
                         f"  - Ablehnungsgrund:        {dbg['discard_reason'] or 'Keiner'}\n\n")
    sys.stderr.write("=======================================\n\n")

    # --- Deduplication: Remove overlapping candidates using Non-Maximum Suppression (NMS) ---
    def calc_iou(a, b):
        x1 = max(a["x"], b["x"])
        y1 = max(a["y"], b["y"])
        x2 = min(a["x"] + a["w"], b["x"] + b["w"])
        y2 = min(a["y"] + a["h"], b["y"] + b["h"])
        inter = max(0, x2 - x1) * max(0, y2 - y1)
        area_a = a["w"] * a["h"]
        area_b = b["w"] * b["h"]
        union = area_a + area_b - inter
        
        # Use IoMin (Intersection over Minimum Area) to catch sub-regions/overlaps
        min_area = min(area_a, area_b)
        iomin = inter / min_area if min_area > 0 else 0
        
        iou = inter / union if union > 0 else 0
        return max(iou, iomin)

    # Sort by confidence descending
    valid_facecams.sort(key=lambda x: x["confidence"], reverse=True)
    
    keep = []
    for fc in valid_facecams:
        is_dup = False
        for existing in keep:
            if calc_iou(fc, existing) > 0.3:
                is_dup = True
                sys.stderr.write(f"[Dedup] Dropped duplicate {fc['corner']} (overlaps with {existing['corner']})\n")
                break
        if not is_dup:
            keep.append(fc)
    valid_facecams = keep

    # For single-webcam selection, prioritize corner facecams (center < 35% or > 65%) over center facecams.
    # This prevents faces inside a central gameplay/reaction video from overriding the actual corner webcam,
    # while still allowing center webcams if no corner webcams are found (e.g. Just Chatting).
    def get_sort_key(fc):
        cx_pct = ((fc["x"] + fc["w"] / 2) / width) * 100
        is_corner = 1 if (cx_pct < 35 or cx_pct > 65) else 0
        return (is_corner, fc["confidence"])

    valid_facecams.sort(key=get_sort_key, reverse=True)

    # Visual debugging: Annotate frames and save to disk
    debug_frames_paths = []
    
    # Save the averaged edges map path first
    edges_rel_path = f"/public/clips/debug_frames/{video_basename}/averaged_edges.jpg"
    
    # Generate 5 evenly spaced visual debug frames for the UI slider
    debug_samples = loaded_frames[::max(1, len(loaded_frames)//5)][:5]
    
    for f_idx, frame in enumerate(debug_samples):
        # ... (drawing boxes) ...
        annotated_frame = frame.copy()
        
        # 1. Draw discarded candidates in RED/YELLOW
        for cand in candidates:
            cx, cy, cw, ch = cand["x"], cand["y"], cand["w"], cand["h"]
            if cand in valid_facecams:
                continue
            color = (0, 0, 255) if cand.get("discard_reason") == "Static HUD/Overlay" else (0, 255, 255)
            cv2.rectangle(annotated_frame, (cx, cy), (cx+cw, cy+ch), color, 1)
            cv2.putText(annotated_frame, f"HUD: {cand.get('motion_score', 0):.2f}", (cx, cy - 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)
                        
        # 2. Draw final valid Facecams in GREEN
        for idx, fc in enumerate(valid_facecams):
            cx, cy, cw, ch = fc["x"], fc["y"], fc["w"], fc["h"]
            cv2.rectangle(annotated_frame, (cx, cy), (cx+cw, cy+ch), (0, 255, 0), 3)
            label = f"Facecam {idx+1} ({fc['confidence']:.2f})"
            cv2.putText(annotated_frame, label, (cx + 5, cy + 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                        
        # Save to file
        frame_filename = f"frame_{f_idx:03d}.jpg"
        frame_filepath = os.path.join(debug_dir, frame_filename)
        cv2.imwrite(frame_filepath, annotated_frame)
        
        # Keep relative URL path for the frontend
        rel_path = ""
        normalized_path = frame_filepath.replace('\\', '/')
        if 'public/' in normalized_path:
            rel_path = "/public/" + normalized_path.split('public/', 1)[1]
        else:
            rel_path = f"/public/clips/debug_frames/{video_basename}/{frame_filename}"
            
        debug_frames_paths.append(rel_path)

    # Prepend the averaged edges map to the debug_frames list for the UI
    debug_frames_paths.insert(0, edges_rel_path)

    # --- Step 5.5: Camera Changes / Layout Changes / Fullcam Check ---
    is_fullcam_detected = False
    is_cam_position_shifted = False
    quadrant_counts = {
        "TL": 0, "TR": 0, "BL": 0, "BR": 0, "CENTER": 0
    }
    
    cascade_detector = None
    try:
        cascade_detector = cv2.CascadeClassifier(cascade_path)
    except Exception as e:
        sys.stderr.write(f"[Layout Rule] Failed to load Haar Cascade: {e}\n")

    valid_faces_count = 0
    fullcam_frames_count = 0

    last_roi_gray = {}
    frame_data = []
    fc_detected_centers = {fc_idx: [] for fc_idx in range(len(valid_facecams))}
    for f_idx, frame in enumerate(loaded_frames):
        # Calculate and log motion for all valid facecam ROIs first
        fc_motions = {}
        for fc_idx, fc in enumerate(valid_facecams):
            try:
                fc_x, fc_y, fc_w, fc_h = fc["x"], fc["y"], fc["w"], fc["h"]
                roi = frame[fc_y:fc_y+fc_h, fc_x:fc_x+fc_w]
                if roi.size > 0:
                    gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                    motion = 999.0
                    if fc_idx in last_roi_gray:
                        prev_roi = last_roi_gray[fc_idx]
                        if prev_roi.shape == gray_roi.shape:
                            diff = cv2.absdiff(gray_roi, prev_roi)
                            motion = float(np.mean(diff))
                    last_roi_gray[fc_idx] = gray_roi
                    fc_motions[fc_idx] = motion
                    sys.stderr.write(f"[Motion Log] Frame {f_idx}: {fc['corner']} motion = {motion:.2f}\n")
            except Exception as e:
                pass

        faces_in_frame = []
        detected_fc_indices_in_frame = []
        has_face_in_fc = False
        frame_data.append({
            "faces": faces_in_frame,
            "detected_fc_indices": detected_fc_indices_in_frame
        })
        h_f, w_f = frame.shape[:2]
        face_found = False
        
        # Try MediaPipe first
        if face_verifier.mp_detector:
            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                res = face_verifier.mp_detector.detect(mp_image)
                if res.detections:
                    for d in res.detections:
                        bx = d.bounding_box.origin_x
                        by = d.bounding_box.origin_y
                        bw = d.bounding_box.width
                        bh = d.bounding_box.height
                        cx = bx + bw / 2.0
                        cy = by + bh / 2.0
                        faces_in_frame.append({
                            "x": bx, "y": by, "w": bw, "h": bh,
                            "cx": cx, "cy": cy, "rel_w": bw / w_f
                        })
                    face_found = True
            except Exception:
                pass
                
        # Fallback to Haar Cascade only if MediaPipe is not available/initialized
        if not face_verifier.mp_detector and cascade_detector:
            try:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = cascade_detector.detectMultiScale(gray, 1.1, 6, minSize=(50, 50))
                for (fx, fy, fw, fh) in faces:
                    faces_in_frame.append({
                        "x": fx, "y": fy, "w": fw, "h": fh,
                        "cx": fx + fw / 2.0, "cy": fy + fh / 2.0,
                        "rel_w": fw / w_f
                    })
            except Exception:
                pass
                
        # Check if there is a face in facecam via full-frame detections or ROI checks in EVERY frame
        for face in faces_in_frame:
            for fc_idx, fc in enumerate(valid_facecams):
                # check if face center is in fc (with 10% padding tolerance)
                pad_w = fc["w"] * 0.10
                pad_h = fc["h"] * 0.10
                in_fc = (fc["x"] - pad_w <= face["cx"] <= fc["x"] + fc["w"] + pad_w) and \
                        (fc["y"] - pad_h <= face["cy"] <= fc["y"] + fc["h"] + pad_h)
                if in_fc:
                    has_face_in_fc = True
                    detected_fc_indices_in_frame.append(fc_idx)
                    roi_cx = face["cx"] - fc["x"]
                    roi_cy = face["cy"] - fc["y"]
                    fc_detected_centers[fc_idx].append((roi_cx, roi_cy))
                    sys.stderr.write(f"  -> Face {face['cx']:.1f},{face['cy']:.1f} matches valid facecam {fc['corner']}\n")
                    break
            if has_face_in_fc:
                break

        # If full-frame detection missed the small corner face, crop each valid facecam ROI
        # and run MediaPipe on it to verify if the corner webcam is still active in this frame.
        if not has_face_in_fc and face_verifier.mp_detector and valid_facecams:
            sys.stderr.write(f"  -> Corner face not found on full frame. Running ROI checks...\n")
            for fc_idx, fc in enumerate(valid_facecams):
                try:
                    fc_x, fc_y, fc_w, fc_h = fc["x"], fc["y"], fc["w"], fc["h"]
                    roi = frame[fc_y:fc_y+fc_h, fc_x:fc_x+fc_w]
                    if roi.size == 0:
                        continue
                    motion = fc_motions.get(fc_idx, 999.0)
                    
                    rgb_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
                    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_roi)
                    res = face_verifier.mp_detector.detect(mp_image)
                    if res.detections:
                        sys.stderr.write(f"    [ROI Check] {fc['corner']}: Found {len(res.detections)} candidate faces. Motion: {motion:.2f}\n")
                        for d in res.detections:
                            face_rel_w = d.bounding_box.width / fc_w if fc_w > 0 else 0
                            fx_c = d.bounding_box.origin_x + d.bounding_box.width / 2.0
                            fy_c = d.bounding_box.origin_y + d.bounding_box.height / 2.0
                            sys.stderr.write(f"      Face in ROI: w={d.bounding_box.width}, rel_w={face_rel_w:.3f}, center=({fx_c:.2f}, {fy_c:.2f})\n")
                            if face_rel_w > 0.08:
                                has_face_in_fc = True
                                detected_fc_indices_in_frame.append(fc_idx)
                                fc_detected_centers[fc_idx].append((fx_c, fy_c))
                                sys.stderr.write(f"      -> Detected face in ROI\n")
                                break
                    else:
                        sys.stderr.write(f"    [ROI Check] {fc['corner']}: No faces found. Motion: {motion:.2f}\n")
                    if has_face_in_fc:
                        break
                except Exception as e:
                    sys.stderr.write(f"    [ROI Check Error] {e}\n")
                    pass

        if faces_in_frame:
            sys.stderr.write(f"Frame {f_idx}: Detected {len(faces_in_frame)} faces:\n")
            for idx_f, face in enumerate(faces_in_frame):
                sys.stderr.write(f"  Face {idx_f}: cx={face['cx']:.1f} ({face['cx']/w_f*100:.1f}%), cy={face['cy']:.1f} ({face['cy']/h_f*100:.1f}%), rel_w={face['rel_w']:.3f}\n")

            fullcam_face = None
            if not has_face_in_fc:
                center_threshold = 0.22 if valid_facecams else 0.15
                is_mp_active = (face_verifier.mp_detector is not None)
                if is_mp_active:
                    center_threshold = 0.12 if valid_facecams else 0.10
                
                for face in faces_in_frame:
                    pct_cx = (face["cx"] / w_f) * 100
                    pct_cy = (face["cy"] / h_f) * 100
                    is_center = (30.0 <= pct_cx <= 70.0) and (20.0 <= pct_cy <= 80.0)
                    if is_center and face["rel_w"] > center_threshold:
                        fullcam_face = face
                        break
            
            if fullcam_face is not None:
                primary_face = fullcam_face
            else:
                # 2. If no Fullcam face is detected, look for faces inside valid facecams
                faces_in_facecam = []
                for face in faces_in_frame:
                    in_any_fc = False
                    for fc in valid_facecams:
                        # check if face center is in fc (with 10% padding tolerance)
                        pad_w = fc["w"] * 0.10
                        pad_h = fc["h"] * 0.10
                        in_this_fc = (fc["x"] - pad_w <= face["cx"] <= fc["x"] + fc["w"] + pad_w) and \
                                     (fc["y"] - pad_h <= face["cy"] <= fc["y"] + fc["h"] + pad_h)
                        if in_this_fc:
                            in_any_fc = True
                            break
                    if in_any_fc:
                        faces_in_facecam.append(face)
                
                if faces_in_facecam:
                    # If we found faces inside valid facecams, sort those by size descending
                    faces_in_facecam.sort(key=lambda f: f["w"] * f["h"], reverse=True)
                    primary_face = faces_in_facecam[0]
                else:
                    # Fallback to sorting all faces in frame by size descending (for fullcam detection or when no facecams are registered)
                    faces_in_frame.sort(key=lambda f: f["w"] * f["h"], reverse=True)
                    primary_face = faces_in_frame[0]
            
            # Check if the primary face lies inside any of our valid facecams
            is_primary_in_fc = False
            for fc in valid_facecams:
                pad_w = fc["w"] * 0.10
                pad_h = fc["h"] * 0.10
                if (fc["x"] - pad_w <= primary_face["cx"] <= fc["x"] + fc["w"] + pad_w) and \
                   (fc["y"] - pad_h <= primary_face["cy"] <= fc["y"] + fc["h"] + pad_h):
                    is_primary_in_fc = True
                    break

            # Filter out tiny faces (likely background game characters) ONLY if they are not in a valid facecam
            if not is_primary_in_fc and primary_face["rel_w"] < 0.05:
                continue
                
            valid_faces_count += 1
            pct_cx = (primary_face["cx"] / w_f) * 100
            pct_cy = (primary_face["cy"] / h_f) * 100
            rel_w = primary_face["rel_w"]
            
            # Fullcam check:
            # The face must be centered, and it must be large:
            # - Extremely large face (> 22% of screen width)
            # - Or moderately large face (> 15% or 22% depending on facecam presence)
            # We use a center bounding box of 30% to 70% width and 20% to 80% height.
            is_center = (30.0 <= pct_cx <= 70.0) and (20.0 <= pct_cy <= 80.0)
            # If MediaPipe is active, we can trust the face detections completely and use a lower threshold.
            is_mp_active = (face_verifier.mp_detector is not None)
            if is_mp_active:
                center_threshold = 0.12 if valid_facecams else 0.10
            else:
                center_threshold = 0.22 if valid_facecams else 0.15
            
            if is_center and not has_face_in_fc:
                if rel_w > center_threshold:
                    fullcam_frames_count += 1
                    sys.stderr.write(f"[Layout Rule] Fullcam (center face) detected in frame {f_idx}! rel_w={rel_w:.2f}, cx={pct_cx:.1f}%\n")
                
            # Classify quadrant for shift check (only count if face is inside a valid facecam candidate)
            if is_primary_in_fc:
                if is_center:
                    quadrant_counts["CENTER"] += 1
                else:
                    q_x = "L" if pct_cx < 50.0 else "R"
                    q_y = "T" if pct_cy < 50.0 else "B"
                    quadrant_counts[q_y + q_x] += 1

    # 1. Identify static poster facecams using coordinate shift of detected centers
    fc_is_static_poster = {}
    for fc_idx, centers in fc_detected_centers.items():
        if len(centers) >= 2:
            xs = [c[0] for c in centers]
            ys = [c[1] for c in centers]
            shift = math.sqrt((max(xs) - min(xs))**2 + (max(ys) - min(ys))**2)
            # If shift is very low, it's a static poster/decor
            is_static = (shift < 5.0)
            fc_is_static_poster[fc_idx] = is_static
            sys.stderr.write(f"[Poster Check] Candidate {valid_facecams[fc_idx]['corner']}: shift = {shift:.2f} pixels, is_static_poster = {is_static}\n")
        else:
            fc_is_static_poster[fc_idx] = False

    # 2. Recount Fullcam frames excluding static poster detections
    fullcam_frames_count = 0
    h_f, w_f = loaded_frames[0].shape[:2] if loaded_frames else (1080, 1920)
    for f_idx, fd in enumerate(frame_data):
        faces = fd["faces"]
        det_fcs = fd["detected_fc_indices"]
        
        # A facecam is active in this frame only if it was detected and is NOT a static poster
        active_fcs = [fc_idx for fc_idx in det_fcs if not fc_is_static_poster.get(fc_idx, False)]
        has_active_face_in_fc = (len(active_fcs) > 0)
        
        # Look for centered face
        fullcam_face = None
        if not has_active_face_in_fc and faces:
            center_threshold = 0.12 if valid_facecams else 0.10
            for face in faces:
                pct_cx = (face["cx"] / w_f) * 100
                pct_cy = (face["cy"] / h_f) * 100
                is_center = (30.0 <= pct_cx <= 70.0) and (20.0 <= pct_cy <= 80.0)
                if is_center and face["rel_w"] > center_threshold:
                    fullcam_face = face
                    break
        
        if fullcam_face is not None:
            fullcam_frames_count += 1
            sys.stderr.write(f"[Recount] Frame {f_idx}: Fullcam confirmed! Center face rel_w={fullcam_face['rel_w']:.2f}\n")

    # Filter out static posters from valid_facecams after using them for fullcam checks
    valid_facecams_clean = []
    for fc_idx, fc in enumerate(valid_facecams):
        if fc_is_static_poster.get(fc_idx, False):
            sys.stderr.write(f"[Poster Filter] Removing candidate {fc['corner']} because it is classified as a static poster/decor.\n")
        else:
            valid_facecams_clean.append(fc)
    valid_facecams = valid_facecams_clean

    # Camera position shift check:
    # Check if there are at least two different positions (quadrants or center) that both have:
    # - At least 2 detections, AND
    # - At least 20% of the total valid face detections in the video.
    if valid_faces_count >= 4:
        active_positions = []
        for pos, count in quadrant_counts.items():
            pct = (count / valid_faces_count) * 100
            if count >= 2 and pct >= 20.0:
                active_positions.append(pos)
        if len(active_positions) >= 2:
            is_cam_position_shifted = True
            sys.stderr.write(f"[Layout Rule] Camera position shift detected! Active positions: {active_positions}, Counts: {quadrant_counts}\n")

    # Require Fullcam frames to represent at least 5% of analyzed frames
    # to distinguish real Fullcam switches from sporadic detection gaps in corner webcams.
    total_analyzed = len(loaded_frames)
    if total_analyzed > 0 and fullcam_frames_count >= 2:
        fullcam_ratio = fullcam_frames_count / total_analyzed
        if fullcam_ratio >= 0.05:
            is_fullcam_detected = True
            sys.stderr.write(f"[Layout Rule] Fullcam confirmed: {fullcam_frames_count}/{total_analyzed} frames ({fullcam_ratio*100:.0f}%)\n")

    if is_fullcam_detected or is_cam_position_shifted:
        sys.stderr.write("[Layout Rule] Video contains multiple camera positions or Fullcam. Forcing blur-bg-logo layout.\n")
        return {
            "layout": "blur-bg-logo",
            "camCrop": {"x": 0, "y": 0, "w": 100, "h": 100},
            "gameCrop": {"x": 0, "y": 0, "w": 100, "h": 100},
            "confidence": 1.0,
            "facecams": [],
            "debug_frames": debug_frames_paths,
            "candidates_debug": candidates_debug
        }

    # Check number of facecams
    if len(valid_facecams) > 1:
        # Filter out candidates with low face detections to prevent HUD/chat false positives in multi-cam classification
        valid_facecams = [fc for fc in valid_facecams if fc["face_ratio"] >= 0.5]

    # If we don't have exactly 3 facecams, discard all fallback candidates ONLY IF there are no static layout divisions.
    # This protects clean full-screen/IRL videos while allowing borderless corner webcams.
    if len(valid_facecams) != 3:
        has_static_divisions = any(not c.get("is_fallback") for c in candidates)
        if not has_static_divisions:
            sys.stderr.write("[Scoring] No static layout divisions detected. Filtering out low-confidence fallback candidates to protect full-screen/IRL videos.\n")
            valid_facecams = [fc for fc in valid_facecams if not fc.get("is_fallback") or (fc.get("face_ratio", 0.0) >= 0.5 and fc.get("confidence", 0.0) >= 0.70)]
        else:
            sys.stderr.write("[Scoring] Static layout divisions detected. Keeping fallback candidates to support borderless corner webcams.\n")

    if len(valid_facecams) > 3:
        sys.stderr.write(f"[Scoring] Too many facecams ({len(valid_facecams)}). Skipping clip.\n")
        return {
            "layout": "too-many-cams",
            "error": f"Mehr als 3 Facecams erkannt ({len(valid_facecams)}). Video wird ignoriert.",
            "camCrop": {"x": 0, "y": 0, "w": 100, "h": 100},
            "gameCrop": {"x": 0, "y": 0, "w": 100, "h": 100},
            "confidence": 0.0,
            "facecams": [],
            "debug_frames": debug_frames_paths,
            "candidates_debug": candidates_debug
        }

    # Check vertical alignment for 3-way layout (webcams must stack vertically in portrait)
    if len(valid_facecams) == 3:
        x_centers = [fc["x"] + fc["w"]/2 for fc in valid_facecams]
        max_x_diff = max(x_centers) - min(x_centers)
        if max_x_diff > width * 0.15:
            sys.stderr.write(f"[Scoring] 3 facecams found but they are not vertically aligned (max_x_diff: {max_x_diff/width*100:.1f}%). Rejecting 3-way layout.\n")
            # Select the single facecam with the highest confidence
            valid_facecams.sort(key=lambda x: x["confidence"], reverse=True)
            valid_facecams = [valid_facecams[0]]
            
    if len(valid_facecams) == 3:
        # Sort them to match Top-Left, Top-Right, Bottom-Center reading order
        sorted_by_y = sorted(valid_facecams, key=lambda f: f["y"])
        bottom_cam = sorted_by_y[2]
        top_cams = sorted(sorted_by_y[:2], key=lambda f: f["x"])
        tl_cam = top_cams[0]
        tr_cam = top_cams[1]
        
        ordered_facecams = [tl_cam, tr_cam, bottom_cam]
        
        # Convert all three to percentage coordinates
        pct_cams = []
        for fc in ordered_facecams:
            pct_cams.append({
                "x": max(0, min(100, int((fc["x"] / width) * 100))),
                "y": max(0, min(100, int((fc["y"] / height) * 100))),
                "w": max(10, min(100, int((fc["w"] / width) * 100))),
                "h": max(10, min(100, int((fc["h"] / height) * 100))),
                "confidence": float(fc["confidence"]),
                "motion_score": float(fc["motion_score"]),
                "face_ratio": float(fc["face_ratio"])
            })
            
        sys.stderr.write(f"[Scoring] Exactly 3 facecams found. Switching to 3-way vertical stack layout.\n")
        return {
            "layout": "3-way",
            "camCrop": pct_cams[0],
            "camCrop2": pct_cams[1],
            "camCrop3": pct_cams[2],
            "gameCrop": {"x": 0, "y": 0, "w": 100, "h": 100}, # Not used in 3-way
            "confidence": float(np.mean([fc["confidence"] for fc in pct_cams])),
            "facecams": pct_cams,
            "debug_frames": debug_frames_paths,
            "candidates_debug": candidates_debug
        }

    if valid_facecams:
        primary = valid_facecams[0]
        bx, by, bw, bh = primary["x"], primary["y"], primary["w"], primary["h"]
        
        # Convert pixel box coordinates to percentages
        cam_x_pct = max(0, min(100, int((bx / width) * 100)))
        cam_y_pct = max(0, min(100, int((by / height) * 100)))
        cam_w_pct = max(10, min(100, int((bw / width) * 100)))
        cam_h_pct = max(10, min(100, int((bh / height) * 100)))
        
        # Center of facecam
        fc_cx_pct = cam_x_pct + cam_w_pct / 2
        
        # Gameplay crop (default center 50% width, full height)
        game_x_pct = 25
        game_y_pct = 0
        game_w_pct = 50
        game_h_pct = 100
        
        # Shift gameplay crop slightly to avoid overlapping the facecam
        if fc_cx_pct < 35:
            game_x_pct = 35
        elif fc_cx_pct > 65:
            game_x_pct = 15

        all_webcams = []
        for fc in valid_facecams:
            all_webcams.append({
                "x": max(0, min(100, int((fc["x"] / width) * 100))),
                "y": max(0, min(100, int((fc["y"] / height) * 100))),
                "w": max(10, min(100, int((fc["w"] / width) * 100))),
                "h": max(10, min(100, int((fc["h"] / height) * 100))),
                "confidence": float(fc["confidence"]),
                "motion_score": float(fc["motion_score"]),
                "face_ratio": float(fc["face_ratio"])
            })

        return {
            "layout": "35",
            "camCrop": {"x": cam_x_pct, "y": cam_y_pct, "w": cam_w_pct, "h": cam_h_pct},
            "gameCrop": {"x": game_x_pct, "y": game_y_pct, "w": game_w_pct, "h": game_h_pct},
            "confidence": float(primary["confidence"]),
            "facecams": all_webcams,
            "debug_frames": debug_frames_paths,
            "candidates_debug": candidates_debug
        }

    return {
        "layout": "blur-bg",
        "camCrop": {"x": 0, "y": 0, "w": 100, "h": 100},
        "gameCrop": {"x": 0, "y": 0, "w": 100, "h": 100},
        "confidence": 0.0,
        "facecams": [],
        "debug_frames": debug_frames_paths,
        "candidates_debug": candidates_debug
    }

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: analyze_clip.py <video_path> <cascade_path>"}))
        sys.exit(1)
    
    video_p = sys.argv[1]
    cascade_p = sys.argv[2]
    result = analyze_video(video_p, cascade_p)
    print(json.dumps(result))
