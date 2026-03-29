from flask import Flask, jsonify, send_from_directory, render_template, request, redirect, url_for
from flask_cors import CORS
import os

app = Flask(__name__)
CORS(app)

SMB_PATH = "/home/atrcb/companyshare"
# --- CHANGE THIS TO YOUR SECRET KEY ---
SECRET_KEY = "Iwasaki_1926!" 

def check_auth():
    # Checks for ?key=... in the URL
    return request.args.get('key') == SECRET_KEY

@app.route('/')
def index():
    if not check_auth():
        return "Unauthorized: Invalid Key", 403
        
    rel_path = request.args.get('path', '').lstrip('/')
    full_path = os.path.join(SMB_PATH, rel_path)
    
    items = []
    if os.path.exists(full_path):
        for name in os.listdir(full_path):
            if name.startswith('.'): continue
            is_dir = os.path.isdir(os.path.join(full_path, name))
            items.append({"name": name, "is_dir": is_dir})
        items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))

    return render_template('index.html', items=items, current_path=rel_path, key=SECRET_KEY)

@app.route('/upload', methods=['POST'])
def upload_file():
    # For Upload, we check the key in the URL parameters
    if not check_auth():
        return "Unauthorized", 403
        
    rel_path = request.form.get('path', '').lstrip('/')
    upload_dir = os.path.join(SMB_PATH, rel_path)
    
    file = request.files.get('file')
    if file and file.filename != '':
        file.save(os.path.join(upload_dir, file.filename))
        # Pass the key back in the redirect so we don't get locked out!
        return redirect(url_for('index', path=rel_path, key=SECRET_KEY))
    return "Upload failed", 400

@app.route('/view/<path:filename>')
def view_file(filename):
    if not check_auth():
        return "Unauthorized", 403
    return send_from_directory(SMB_PATH, filename, as_attachment=False)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)