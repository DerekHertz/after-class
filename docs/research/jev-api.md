# Jev HTTP API notes

Gathered 2026-11-03 from the installed `@dzhng/jevgrep` bundle (its vendored `@ai-sdk/typesafe-ai@3.0.8` provider) and the official image docs at https://docs.typesafe.ai/go/images. No live call has been made yet.

## Request

`POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer $TYPESAFE_API_KEY`.

```json
{
  "model": "jev-1.13",
  "state": { "any": "JSON the questions refer to" },
  "questions": {
    "new_concept": { "type": "noul", "instructions": "Does state.passage begin ...?" }
  }
}
```

- Question types: `noul` (boolean, answer is a probability), `choice` (`criteria` map, at most 255 options), `score` (`criteria` list, at most 10 levels).
- jevgrep puts shared criteria and guidance in `state` and points each question's `instructions` at it ("Apply state.criteria.relevance to state.declarations[3]").
- jevgrep uses model `jev-1.13` / `jev-1.13.0`; the image docs use `jev-latest`. Jev 1.14 exists (Oct 2026).

## Response

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "new_concept": { "type": "noul", "noul": 0.82 },
    "pick": { "type": "choice", "choice": "a", "probabilities": { "a": 0.7, "b": 0.3 }, "confidence": 0.9 }
  },
  "usage": { "input_tokens": 1234, "output_tokens": 5 }
}
```

Errors are JSON with some of `message`, `detail`, `error`, `error_type`. The response carries tokens only, no money. Cost stays unknown until TypeSafe's pricing is known.

## Images (experimental, "Danger Zone")

- Header `TypeSafe-Danger-Zone-Images: true` on every request with an image.
- Top-level `assets` keyed by reference string: `{ "type": "image", "format": "png"|"jpg"|"jpeg", "data_base64": "..." }`, or multipart with `part`.
- Put the reference string as plain text in `state`, `instructions` or `criteria`. Every asset must be referenced. Each use adds another copy of the image.
- Limits: PNG/JPEG still images, 280–1568 px per side, 78,400–2,458,624 total pixels, 16 MiB per image, 32 MiB request. Images out of bounds are rejected, not resized; one bad image fails the request.
- Jev 1.13 and 1.14 accept images. TypeSafe says multimodal accuracy is lower than text-only and recommends simple, decomposed questions.
