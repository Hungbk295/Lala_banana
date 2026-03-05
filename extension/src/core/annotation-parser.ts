import type { Editor, TLShape, TLShapeId } from 'tldraw';
import { normalizeToImageCoords } from './coordinate-transform';
import type { ParsedAnnotation, NormalizedRect } from './types';

function regionDistance(a: NormalizedRect, b: NormalizedRect): number {
  const aCenterX = a.x + a.w / 2;
  const aCenterY = a.y + a.h / 2;
  const bCenterX = b.x + b.w / 2;
  const bCenterY = b.y + b.h / 2;
  return Math.sqrt((aCenterX - bCenterX) ** 2 + (aCenterY - bCenterY) ** 2);
}

function resolveProximityRelations(
  annotations: ParsedAnnotation[]
): ParsedAnnotation[] {
  const highlights = annotations.filter((a) => a.type === 'highlight');
  const texts = annotations.filter((a) => a.type === 'instruction');

  for (const text of texts) {
    if (!text.region) continue;
    for (const highlight of highlights) {
      if (!highlight.region) continue;
      const distance = regionDistance(text.region, highlight.region);
      if (distance < 0.05) {
        highlight.text = text.text;
        text._merged = true;
      }
    }
  }

  return annotations.filter((a) => !a._merged);
}

export function parseAnnotations(
  editor: Editor,
  imageShapeId: TLShapeId
): ParsedAnnotation[] {
  const shapes = editor.getCurrentPageShapes();
  const imageShape = editor.getShape(imageShapeId);
  if (!imageShape) return [];

  const imageProps = imageShape as TLShape & {
    props: { w: number; h: number };
  };
  const annotationShapes = shapes.filter((s) => s.id !== imageShapeId);
  const annotations: ParsedAnnotation[] = [];

  for (const shape of annotationShapes) {
    switch (shape.type) {
      case 'geo': {
        const geo = shape as TLShape & { props: { w: number; h: number } };
        const region = normalizeToImageCoords(
          { x: shape.x, y: shape.y, w: geo.props.w, h: geo.props.h },
          imageProps
        );
        annotations.push({
          type: 'highlight',
          region,
          _shapeId: shape.id,
        });
        break;
      }

      case 'arrow': {
        const arrowShape = shape as TLShape & {
          props: {
            start: { x: number; y: number };
            end: { x: number; y: number };
          };
        };
        const from = normalizeToImageCoords(
          {
            x: arrowShape.props.start.x + shape.x,
            y: arrowShape.props.start.y + shape.y,
            w: 0,
            h: 0,
          },
          imageProps
        );
        const to = normalizeToImageCoords(
          {
            x: arrowShape.props.end.x + shape.x,
            y: arrowShape.props.end.y + shape.y,
            w: 0,
            h: 0,
          },
          imageProps
        );

        annotations.push({
          type: 'arrow',
          pointer: { from, to },
          _shapeId: shape.id,
        });
        break;
      }

      case 'text': {
        const text = shape as TLShape & { props: { text: string } };
        const region = normalizeToImageCoords(
          { x: shape.x, y: shape.y, w: 100, h: 30 },
          imageProps
        );
        annotations.push({
          type: 'instruction',
          text: text.props.text,
          region,
          _shapeId: shape.id,
        });
        break;
      }

      case 'draw': {
        // MVP: skip freehand
        break;
      }
    }
  }

  return resolveProximityRelations(annotations);
}
