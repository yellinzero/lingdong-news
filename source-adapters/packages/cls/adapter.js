function fetch(ctx) {
  const seconds = Math.floor(ctx.now / 1000);
  const query = `appName=CailianpressWeb&last_time=${seconds}&os=web&refresh_type=1&rn=50&sv=7.7.5`;
  const sign = ctx.md5(ctx.sha1(query));
  const response = ctx.request({
    url: `https://www.cls.cn/v1/roll/get_roll_list?${query}&sign=${sign}`,
    headers: {Referer: 'https://www.cls.cn/telegraph'}
  });
  if (response.status !== 200) throw new Error(`上游 HTTP ${response.status}`);
  return ctx.mapJSON(response.text, {
  "itemsPath": "data.roll_data",
  "idPath": "id",
  "titlePath": "title",
  "bodyPaths": [
    "content",
    "brief"
  ],
  "datePath": "ctime",
  "dateUnit": "seconds",
  "urlTemplate": "https://www.cls.cn/detail/{id}",
  "exclude": [
    {
      "path": "is_ad",
      "op": "truthy"
    }
  ]
});
}
