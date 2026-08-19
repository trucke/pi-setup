import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FooterSegment {
  text: string;
  compactText?: string;
  compactAt?: number;
  dropAt?: number;
}

interface ActiveSegment extends FooterSegment {
  currentText: string;
}

interface LayoutAction {
  priority: number;
  apply(): void;
}

function joinSegments(segments: readonly ActiveSegment[], separator: string) {
  return segments
    .map((segment) => segment.currentText)
    .filter(Boolean)
    .join(separator);
}

function requiredWidth(
  left: readonly ActiveSegment[],
  right: readonly ActiveSegment[],
  separator: string,
) {
  const leftText = joinSegments(left, separator);
  const rightText = joinSegments(right, separator);
  return (
    visibleWidth(leftText) +
    visibleWidth(rightText) +
    (leftText && rightText ? 1 : 0)
  );
}

function renderLine(
  left: readonly ActiveSegment[],
  right: readonly ActiveSegment[],
  separator: string,
  width: number,
) {
  const leftText = joinSegments(left, separator);
  const rightText = joinSegments(right, separator);

  if (!leftText) return truncateToWidth(rightText, width, "");
  if (!rightText) return truncateToWidth(leftText, width, "");

  const gap = Math.max(
    1,
    width - visibleWidth(leftText) - visibleWidth(rightText),
  );
  return truncateToWidth(
    `${leftText}${" ".repeat(gap)}${rightText}`,
    width,
    "",
  );
}

/** Fit a stable left/right footer by applying explicit compaction and drop priorities. */
export function fitFooterLine(
  leftSegments: readonly FooterSegment[],
  rightSegments: readonly FooterSegment[],
  width: number,
  separator: string,
) {
  const left = leftSegments
    .filter((segment) => segment.text)
    .map((segment) => ({ ...segment, currentText: segment.text }));
  const right = rightSegments
    .filter((segment) => segment.text)
    .map((segment) => ({ ...segment, currentText: segment.text }));
  const actions: LayoutAction[] = [];

  for (const segment of [...left, ...right]) {
    if (
      segment.compactText !== undefined &&
      segment.compactText !== segment.text &&
      segment.compactAt !== undefined
    ) {
      actions.push({
        priority: segment.compactAt,
        apply: () => {
          segment.currentText = segment.compactText ?? "";
        },
      });
    }
    if (segment.dropAt !== undefined) {
      actions.push({
        priority: segment.dropAt,
        apply: () => {
          segment.currentText = "";
        },
      });
    }
  }

  actions.sort((a, b) => a.priority - b.priority);
  for (const action of actions) {
    if (requiredWidth(left, right, separator) <= width) break;
    action.apply();
  }

  return renderLine(left, right, separator, width);
}
