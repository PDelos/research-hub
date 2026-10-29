# The local embedder's server (design v1-8 D6): POST /embed {"model": "<folder>", "texts": [...]} -> {"vectors": [...]}
# with L2-normalized sentence-transformers embeddings; GET /health. Models load once and stay in memory.
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from sentence_transformers import SentenceTransformer

models = {}

def model(path):
    if path not in models:
        models[path] = SentenceTransformer(path, device="cpu")
    return models[path]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"status": "ok"})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            vectors = model(body["model"]).encode(body["texts"], normalize_embeddings=True, batch_size=16)
            self.reply(200, {"vectors": [v.tolist() for v in vectors]})
        except Exception as error:  # the hub shows the message
            self.reply(500, {"error": str(error)})

port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 5002
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
