export const isMacOS = () =>
  /mac/i.test(navigator.platform) || navigator.userAgent.includes("Macintosh");
