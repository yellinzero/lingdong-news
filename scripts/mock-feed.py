#!/usr/bin/env python3
"""Local fixture endpoints for all source adapters; no real news or credentials."""
import json
import sys
from datetime import datetime, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from xml.sax.saxutils import escape

STAMP = datetime.now(timezone.utc)
ROWS = [
    {'id': 'mock-1', 'body': '模拟消息：某芯片公司宣布扩大产能，仅用于测试浮窗。', 'tags': ['模拟', '半导体']},
    {'id': 'mock-2', 'body': '模拟消息：某市发布周末天气预报，仅用于测试未命中新闻仍然展示。', 'tags': ['模拟', '天气']}
]

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/plugin-news':
            self.send_error(404);return
        size=int(self.headers.get('Content-Length','0'))
        if size>256*1024:self.send_error(413);return
        try: payload=json.loads(self.rfile.read(size))
        except (ValueError,UnicodeDecodeError): self.send_error(400);return
        if not isinstance(payload.get('channel'),str):self.send_error(400);return
        body=json.dumps({'rows':[{'uid':r['id'],'text':r['body'],'seconds':STAMP.timestamp()} for r in ROWS]},ensure_ascii=False).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/news':
            payload = {'version': 1, 'items': [{**r, 'publishedAt': STAMP.isoformat()} for r in ROWS]}
            body, mime = json.dumps(payload, ensure_ascii=False), 'application/json'
        elif path == '/raw':
            payload = {'data': {'rows': [{'uid': r['id'], 'headline': '', 'content': '<p>' + r['body'] + '</p>', 'time': STAMP.timestamp(), 'link': '', 'labels': r['tags']} for r in ROWS]}}
            body, mime = json.dumps(payload, ensure_ascii=False), 'application/json'
        elif path == '/rss.xml':
            entries = ''.join('<item><guid>' + escape(r['id']) + '</guid><description>' + escape('<p>' + r['body'] + '</p>') + '</description><pubDate>' + format_datetime(STAMP) + '</pubDate>' + ''.join('<category>' + escape(t) + '</category>' for t in r['tags']) + '</item>' for r in ROWS)
            body, mime = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>本地模拟 RSS</title><link>http://127.0.0.1</link><description>开发测试</description>' + entries + '</channel></rss>', 'application/rss+xml'
        elif path == '/atom.xml':
            entries = ''.join('<entry><id>' + escape(r['id']) + '</id><title>模拟消息</title><updated>' + STAMP.isoformat() + '</updated><content type="html">' + escape('<p>' + r['body'] + '</p>') + '</content></entry>' for r in ROWS)
            body, mime = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:newsfloat:demo</id><title>本地模拟 Atom</title><updated>' + STAMP.isoformat() + '</updated>' + entries + '</feed>', 'application/atom+xml'
        else:
            self.send_error(404)
            return
        encoded = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'模拟源：http://127.0.0.1:{port}/news /raw /rss.xml /atom.xml', flush=True)
    HTTPServer(('127.0.0.1', port), Handler).serve_forever()
