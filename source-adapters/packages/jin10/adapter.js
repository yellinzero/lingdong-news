function fetch(ctx) {
  const response = ctx.request({
    url: `https://www.jin10.com/flash_newest.js?t=${Math.floor(ctx.now / 1000)}`,
    headers: {Referer: 'https://www.jin10.com/'}
  });
  if (response.status !== 200) throw new Error(`上游 HTTP ${response.status}`);
  return ctx.mapJSON(response.text, {
  "itemsPath": "",
  "idPath": "id",
  "titlePath": "data.title",
  "bodyPaths": [
    "data.content"
  ],
  "datePath": "time",
  "dateUnit": "local",
  "timezone": "+08:00",
  "urlTemplate": "https://flash.jin10.com/detail/{id}",
  "jsonPrefix": "var newest =",
  "exclude": [
    {
      "path": "channel",
      "op": "contains",
      "value": 5
    },
    {
      "path": "data.lock",
      "op": "truthy"
    },
    {
      "path": "data.vip_level",
      "op": "gt",
      "value": 0
    }
  ]
});
}
