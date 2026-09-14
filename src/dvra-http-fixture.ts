// Two loopback-only servers inside the disposable API container. One serves a
// permitted image; the other records forbidden-destination requests as evidence.
export const DVRA_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3sAAAAASUVORK5CYII=';
export const DVRA_HTTP_FIXTURE = String.raw`
import sys, json, re, base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
port, kind = int(sys.argv[1]), sys.argv[2]
counts = {}
image = base64.b64decode('${DVRA_IMAGE_BASE64}')
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def send(self, status, data, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path == '/_gauntlet/health':
            return self.send(200,json.dumps({'protocol':'gauntlet-image-v1','kind':kind}).encode())
        match = re.fullmatch(r'/_gauntlet/state/(gauntlet-[a-f0-9]{24})',self.path)
        if match:
            return self.send(200,json.dumps({'requests':counts.get(match[1],0)}).encode())
        match = re.fullmatch(r'/(gauntlet-[a-f0-9]{24})/image.png',self.path)
        if match:
            counts[match[1]] = counts.get(match[1],0) + 1
            return self.send(200,image,'image/png')
        return self.send(404,b'{}')
    def do_DELETE(self):
        match = re.fullmatch(r'/_gauntlet/state/(gauntlet-[a-f0-9]{24})',self.path)
        if not match:
            return self.send(404,b'{}')
        counts.pop(match[1],None)
        return self.send(200,b'{}')
ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
`;
