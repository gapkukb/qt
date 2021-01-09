import { StringTypeMapping } from "./TypeBuilder";

export interface RunContext {
  stringTypeMapping: StringTypeMapping;
  debugPrintReconstitution: boolean;
  debugPrintTransformations: boolean;
  debugPringSchemaResolving: boolean;
  timeSync<T>(name: string, f: () => Promise<T>): Promise<T>;
  time<T>(name: string, f: () => T): T;
}
