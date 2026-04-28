export const getMediaFileName = (filePath: string) =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || "Untitled video";
