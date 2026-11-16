function fetch(ctx) {
  const response = ctx.request({
    url: 'http://127.0.0.1:18765/plugin-news', method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({channel: ctx.config.channel})
  });
  if (response.status !== 200) throw new Error(`上游 HTTP ${response.status}`);
  const data = JSON.parse(response.text);
  return {version: 1, items: data.rows.map(row => ({
    id: String(row.uid), body: row.text,
    publishedAt: row.seconds * 1000, tags: [ctx.config.channel]
  }))};
}
