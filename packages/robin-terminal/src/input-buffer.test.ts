import assert from "node:assert/strict";
import test from "node:test";

import {
  createInputBuffer,
  deleteInputBackward,
  deleteInputForward,
  deleteInputWordBackward,
  graphemeCellWidth,
  inputBufferText,
  inputCellWidth,
  inputSelection,
  insertInputText,
  moveInputCursor,
  moveInputCursorBy,
  segmentGraphemes,
} from "./input-buffer.js";

test("segments composed, decomposed, emoji, flags, and wide text by grapheme", () => {
  const text = "Aé e\u0301 👩🏽‍💻 🇺🇸 界";
  const graphemes = segmentGraphemes(text);
  assert.deepEqual(graphemes, ["A", "é", " ", "e\u0301", " ", "👩🏽‍💻", " ", "🇺🇸", " ", "界"]);
  assert.equal(graphemeCellWidth("e\u0301"), 1);
  assert.equal(graphemeCellWidth("\u0301"), 0);
  assert.equal(graphemeCellWidth("👩🏽‍💻"), 2);
  assert.equal(graphemeCellWidth("🇺🇸"), 2);
  assert.equal(graphemeCellWidth("©️"), 2);
  assert.equal(graphemeCellWidth("界"), 2);
  assert.equal(inputCellWidth(createInputBuffer("A界👩🏽‍💻")), 5);
});

test("immutable insertion, movement, selection deletion, and word deletion preserve boundaries", () => {
  const original = createInputBuffer("A👩🏽‍💻界");
  const middle = moveInputCursor(original, 1);
  const inserted = insertInputText(middle, "e\u0301");
  assert.equal(inputBufferText(original), "A👩🏽‍💻界");
  assert.equal(inputBufferText(inserted), "Ae\u0301👩🏽‍💻界");
  assert.equal(inserted.cursor, 2);

  const selected = moveInputCursor(createInputBuffer("one two"), 3, true);
  assert.deepEqual(inputSelection(selected), { start: 3, end: 7 });
  assert.equal(inputBufferText(deleteInputBackward(selected)), "one");

  const beforeEmoji = moveInputCursor(createInputBuffer("a👩🏽‍💻b"), 1);
  assert.equal(inputBufferText(deleteInputForward(beforeEmoji)), "ab");
  assert.equal(
    inputBufferText(deleteInputWordBackward(createInputBuffer("one   two"))),
    "one   ",
  );
  assert.equal(moveInputCursorBy(createInputBuffer("x"), -99).cursor, 0);
  assert.equal(Object.isFrozen(original.graphemes), true);
  assert.equal(Object.isFrozen(original), true);
});
