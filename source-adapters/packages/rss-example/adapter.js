function fetch(ctx) {
  const response = ctx.request({url: ctx.config.url});
  if (response.status !== 200) throw new Error(`上游 HTTP ${response.status}`);
  return ctx.parseFeed(response.text, ctx.config.url);
}
