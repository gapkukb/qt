import { TypeAttributes } from "./attributes/TypeAttributes";
import { Transformation, transformationTypeAttributeKind, Transformer } from "./Transformers";
import { TypeGraph, TypeRef, typeRefIndex } from "./TypeGraph";

function transformationAttributes(
  graph: TypeGraph,
  reconstituedTargetType: TypeRef,
  transformer: Transformer,
  debug: boolean
): TypeAttributes {
  const transformation = new Transformation(graph, reconstituedTargetType, transformer);
  if (debug) {
    console.log(`transformation for ${typeRefIndex(reconstituedTargetType)}:`);
    transformation.debugPrint();
    console.log(`reverse:`);
    transformation.reverse.debugPrint();
  }
  return transformationTypeAttributeKind.makeAttributes(transformation);
}
