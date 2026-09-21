import type { GenerateContainerfileOptions } from "./buildImage.js";

export interface ContainerfileTemplate {
  generate(options: GenerateContainerfileOptions): Promise<string> | string;
}
