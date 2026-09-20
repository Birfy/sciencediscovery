# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Minimal OpenAI-compatible streaming stub: replies with fixed text."""
import json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get("STUB_LLM_LOG")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
        self.wfile.write(json.dumps({"data":[{"id":"stub-model","object":"model"}]}).encode())
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if LOG: open(LOG,"a").write(json.dumps(body, ensure_ascii=False)+"\n")
        def chunk(delta, finish=None):
            return "data: "+json.dumps({"id":"c1","object":"chat.completion.chunk","created":int(time.time()),"model":"stub-model","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})+"\n\n"
        if body.get("stream"):
            self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
            for part in ["hello ", "from ", "stub"]:
                self.wfile.write(chunk({"content":part}).encode()); self.wfile.flush()
            self.wfile.write(chunk({}, "stop").encode()); self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"id":"c1","object":"chat.completion","model":"stub-model","choices":[{"index":0,"message":{"role":"assistant","content":"hello from stub"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":3,"total_tokens":4}}).encode())

ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("STUB_LLM_PORT", "18999"))), H).serve_forever()
