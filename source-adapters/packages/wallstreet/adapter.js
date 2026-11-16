function fetch(ctx) {
  const response = ctx.request({
    url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=50'
  });
  if (response.status !== 200) throw new Error(`上游 HTTP ${response.status}`);
  return ctx.mapJSON(response.text, {
  "itemsPath": "data.items",
  "idPath": "id",
  "titlePath": "title",
  "bodyPaths": [
    "content_text",
    "content"
  ],
  "datePath": "display_time",
  "dateUnit": "seconds",
  "urlPath": "uri",
  "urlTemplate": "https://wallstreetcn.com/live/{id}"
});
}
