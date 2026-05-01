export function getCookie(): string {
  const c = process.env.APPSHEET_COOKIE?.trim();
  if (!c) {
    throw new Error(
      "APPSHEET_COOKIE が .env に設定されていません。AppSheet Editor を開いた状態で DevTools の Network タブで saveapp を右クリック → Copy as cURL し、その -b 値を抽出して .env に書いてください。",
    );
  }
  return c;
}

export function getEditorHeaders(appName: string): Record<string, string> {
  return {
    Cookie: getCookie(),
    Origin: "https://www.appsheet.com",
    Referer: `https://www.appsheet.com/template/AppDef?appName=${encodeURIComponent(appName)}`,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
  };
}
