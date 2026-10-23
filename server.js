// Find the actual image URL from yt-dlp metadata.
// Supports single-image posts and carousel entries.
function pickImageUrl(j) {
  if (!j) return null;

  // Instagram carousel: inspect every post item.
  if (Array.isArray(j.entries) && j.entries.length) {
    for (const entry of j.entries) {
      const image = pickImageUrl(entry);
      if (image) return image;
    }
  }

  // Direct image URL.
  if (
    j.url &&
    IMG_EXTS.includes(String(j.ext || "").toLowerCase())
  ) {
    return j.url;
  }

  // Prefer actual image formats, not video thumbnails.
  if (Array.isArray(j.formats)) {
    const images = j.formats.filter(
      (f) =>
        f &&
        f.url &&
        IMG_EXTS.includes(String(f.ext || "").toLowerCase())
    );

    if (images.length) {
      return images[images.length - 1].url;
    }
  }

  // Do not use j.thumbnail here:
  // it may be a video's preview image.
  return null;
}
