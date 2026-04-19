const getMediaFileStem = (filePath: string) => {
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || "video";
  const extensionIndex = fileName.lastIndexOf(".");

  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
};

export const getExportDefaultPath = (filePath: string) => {
  const safeStem = getMediaFileStem(filePath)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();

  return `${safeStem || "video"}.mp4`;
};
