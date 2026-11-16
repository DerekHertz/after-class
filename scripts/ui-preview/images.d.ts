/** The dev page imports images by URL. Bun.build turns each into a served file path. */
declare module "*.webp" {
  const url: string;
  export default url;
}
