import path from "node:path";
import sharp from "sharp";

export type ImageArtifact = {
  filePath: string;
  url: string;
  pngPath: string;
  pngUrl: string;
  jpgPath: string;
  jpgUrl: string;
};

export function generatedUrl(filePath: string) {
  return `/generated/${path.basename(filePath)}`;
}

export async function createJpgVariant(pngPath: string) {
  const parsed = path.parse(pngPath);
  const jpgPath = path.join(parsed.dir, `${parsed.name}.jpg`);

  await sharp(pngPath)
    .flatten({ background: "#05070b" })
    .jpeg({
      quality: 95,
      chromaSubsampling: "4:4:4",
      mozjpeg: true
    })
    .toFile(jpgPath);

  return {
    jpgPath,
    jpgUrl: generatedUrl(jpgPath)
  };
}

export async function createImageArtifact(pngPath: string): Promise<ImageArtifact> {
  const { jpgPath, jpgUrl } = await createJpgVariant(pngPath);
  const pngUrl = generatedUrl(pngPath);

  return {
    filePath: pngPath,
    url: pngUrl,
    pngPath,
    pngUrl,
    jpgPath,
    jpgUrl
  };
}
