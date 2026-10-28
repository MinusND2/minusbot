with open('d:/bingo/backend/clipper.js', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f, 1):
        if 'done' in line or 'clip' in line:
            if 'status' in line or 'url' in line or 'db.ref' in line:
                print(f"L{i}: {line.strip()}")
