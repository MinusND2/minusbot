import os
import cv2
import json
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

model_path = '/var/www/bot/face_detector.tflite'
video_path = '/var/www/bingo/public/clips/twitch_AntediluvianManlySeahorseChefFrank-4SOBXw8a453s6ELl.mp4'

base_options = python.BaseOptions(model_asset_path=model_path)
options = vision.FaceDetectorOptions(base_options=base_options, min_detection_confidence=0.35)
detector = vision.FaceDetector.create_from_options(options)

cap = cv2.VideoCapture(video_path)
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

percentages = [0.1, 0.3, 0.5, 0.7, 0.9]
for p in percentages:
    idx = int(total_frames * p)
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ret, frame = cap.read()
    if ret:
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        detection_result = detector.detect(mp_image)
        print(f"Frame at {int(p*100)}%: Detections count: {len(detection_result.detections)}")
        for idx_det, d in enumerate(detection_result.detections):
            bbox = d.bounding_box
            score = d.categories[0].score if d.categories else 0.0
            print(f"  Det {idx_det}: x={bbox.origin_x}, y={bbox.origin_y}, w={bbox.width}, h={bbox.height}, score={score:.2f}")
    else:
        print(f"Frame at {int(p*100)}%: Failed to read")

cap.release()
