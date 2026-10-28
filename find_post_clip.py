with open('d:/bingo/backend/server.js', 'r', encoding='utf-8') as f:
    for i, line in enumerate(f, 1):
        if '/api/clipper/clip' in line:
            print(f"L{i}: {line.strip()}")
