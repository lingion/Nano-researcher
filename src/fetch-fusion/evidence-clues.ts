export function detectSuspectedReprint(args: {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
}): boolean {
  const combinedText = `${args.title}\n${args.content}`;
  const lowerUrl = `${args.requestedUrl} ${args.finalUrl}`.toLowerCase();
  const isOfficialPage = /\.gov\.cn(?=\/|$)/i.test(args.finalUrl);
  const suspectedReprintByText = /转载|来源[:：]|日报|晚报|新闻网|news/i.test(combinedText);
  const suspectedReprintByUrl = !isOfficialPage && /(news|media|reprint)/i.test(lowerUrl);

  return suspectedReprintByText || suspectedReprintByUrl;
}
