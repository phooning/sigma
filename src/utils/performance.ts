export const markPerformance = (name: string) => {
  if (
    typeof performance === "undefined" ||
    typeof performance.mark !== "function"
  ) {
    return;
  }

  performance.mark(name);
};
