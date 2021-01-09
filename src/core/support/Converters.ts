import { EnumOption } from "../RendererOption";

export enum ConvertersOption {
  TopLevel = "top-level",
  AllObjects = "all-objects",
}

export function convertersOption() {
  return new EnumOption(
    "converters",
    "Which converters to generate (top-level by default)",
    [
      [ConvertersOption.TopLevel, ConvertersOption.TopLevel],
      [ConvertersOption.AllObjects, ConvertersOption.AllObjects],
    ],
    ConvertersOption.TopLevel,
    "secondary"
  );
}
