import cv2
import os

cascade_path = '/var/www/bot/haarcascade_frontalface_default.xml'
video_path = '/var/www/bingo/public/clips/twitch_AntediluvianManlySeahorseChefFrank-4SOBXw8a453s6ELl.mp4'

detector = cv2.CascadeClassifier(cascade_path)
cap = cv2.VideoCapture(video_path)
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
cap.set(cv2.CAP_PROP_POS_FRAMES, int(total_frames * 0.5))
ret, frame = cap.read()
cap.release()

if ret:
    height, width, _ = frame.shape
    # Bottom-left corner: x from 0 to 35% of width, y from 55% of height to height
    x1, y1 = 0, int(height * 0.5)
    x2, y2 = int(width * 0.35), height
    
    bl_crop = frame[y1:y2, x1:x2]
    gray = cv2.cvtColor(bl_crop, cv2.COLOR_BGR2GRAY)
    
    detections = detector.detectMultiScale(
        gray,
        scaleFactor=1.05,
        minNeighbors=3,
        minSize=(30, 30)
    )
    
    print(f"Crop resolution: {bl_crop.shape[1]}x{bl_crop.shape[0]}")
    print(f"Detections in bottom-left corner: {len(detections)}")
    for idx, (x, y, w, h) in enumerate(detections):
        # Map back to original frame coordinates
        orig_x = x1 + x
        orig_y = y1 + y
        print(f"  Det {idx}: original x={orig_x}, y={orig_y}, w={w}, h={h}")
else:
    print("Failed to read frame")
