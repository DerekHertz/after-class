# Front-row pixel skins review

final result: passed

This is an implementation QA result for the tested fixture states, not a merge authorization or Derek's visual sign-off. The reviewed product-code commit is `494faae7c492f7741171eb56d6687b2084c5d363`. This report and its screenshots are a documentation-only follow-up.

## Visual target and evidence

Derek selected all three refined anime pixel concepts, then required the artwork to fill the interface without an opaque outer frame. His later browser comment also rejected the flat blue backdrop around source and history. Those instructions supersede the solid header bands in the source references.

| Room | Selected source | Rendered desktop |
| --- | --- | --- |
| Rail-side Classroom | [Reference](docs/design/front-row/selected/rail-classroom.png) | [1440x900](docs/design/front-row/review/rail-final-desktop.jpg) |
| Harbor Study Terrace | [Reference](docs/design/front-row/selected/harbor-terrace.png) | [1440x900](docs/design/front-row/review/harbor-final-desktop.jpg) |
| Lantern Canal Film Club | [Reference](docs/design/front-row/selected/canal-film-club.png) | [1440x900](docs/design/front-row/review/canal-final-desktop.jpg) |

Sources are1586x992 pixels. Desktop captures are1440x900 pixels at a1440x900 CSS viewport, one captured pixel per CSS pixel. The aspect ratios are almost identical. Each source and its rendered room were opened together in the same comparison input. This is a proportional composition comparison, not a pixel-difference score. The mock has a single illustrative question; the real fixture also contains an explanation, provenance and a diagram control. The extra content and smaller type needed for it are intentional product behavior. Companion choices are independent, so their selection can differ from the mock.

The full-resolution comparisons make the board, typing field, caret/focus outline and action labels readable without a separate enlarged crop. Live DOM bounds were checked for the board, navigation, desk and phone help controls.

Additional evidence:

- [History with artwork behind its panels](docs/design/front-row/review/history-art-1676.jpg),1676x954 viewport and capture, matching the reported blue-background problem.
- [Phone source panel over artwork](docs/design/front-row/review/canal-source-phone-final.jpg),390x844 viewport and capture.
- Phone layout captures: [rail](docs/design/front-row/review/rail-final-phone.jpg), [harbor](docs/design/front-row/review/harbor-final-phone.jpg), [canal](docs/design/front-row/review/canal-final-phone.jpg). These full-page captures are390x922 from a390x844 viewport. Assess the first844px for the required initial view. The black area beyond that viewport is a fixed-background full-page capture artifact; the actual scrolled phone viewport above confirms artwork behind the companion/source area.

The app ran from the isolated deterministic preview at http://127.0.0.1:8820/. No live lectures, provider calls or claimed learning-effectiveness results were involved.

## Findings and fixes

1. P1, the initial room had106px solid header bands and side gutters. The full-viewport stage and navigation chips removed the outer frame. The final desktop captures show art to every edge.
2. P1, opening source narrowed the room and clipped answer/help controls. Source and history now open as paper panels below an unchanged room. All three selected artworks remain behind those panels.
3. P2, the canal keyboard shortcut clipped at the mat bottom and phone help ended around893px. The shortcut moved beside the field label on desktop. The phone lost the extra scenery strip and uses a readable80px input. Direct help now ends at739.6px in all three ordinary390x844 fixtures, with44px button heights and no horizontal overflow.
4. P2, desktop navigation covered the rail topic heading after wrapping. The navigation now measures the space it occupies. After the final resize check, navigation ended at109.1px and board content began at121px.
5. P2, the harbor diagram action was mostly below the board edge. It now shares the topic-heading row and the board's safe content area is taller. The ordinary fixture has299px client and scroll height, so it needs no board scrolling.
6. P1, the source/history area fell back to a flat blue background. A fixed selected-room artwork backdrop now covers the scrolling review. The reported1676x954 history view and the phone source view were inspected after the fix.
7. P2, switching from phone to desktop exposed a hidden32px scroll offset in the decorative scene. The scene now uses overflow:clip, while board and desk retain intentional scrolling. After repeating the resize and input-focus sequence, scene scrollTop was0 and the stage bounds were0..900. The blurred fallback strip was also removed.

The initial pass was blocked. The first full-viewport pass fixed1-3 and exposed4-5. The next pass fixed4-5. Derek's browser comment identified6, which was then fixed. The final cross-size pass identified7. All final desktop captures were taken after the fix for7. The backdrop/phone evidence predates only that desktop-specific clipping change.

## Required fidelity checks

- Fonts and typography: local Pixelify Sans loads for board, input and controls. Editable text, placeholder, labels, caret and focus remain real DOM. Required labels are readable at the tested sizes. The visual hierarchy follows a dominant question, smaller explanation and a desk answer field.
- Spacing and layout: desktop board and desk stay on their painted surfaces. There is no solid outer frame. Ordinary phone question, input, Share, Hint and I don't know fit within844px. Source/history do not squeeze the scene. The phone deliberately recomposes the controls instead of shrinking desktop coordinates.
- Colors: the rail and harbor use cream text on green boards and dark text on cream mats. The canal uses navy text on a cream screen and cream text on a navy mat. Existing asset tests sample the actual plate colors for contrast. Local navigation/paper backing remains for readable controls, distinct from the removed page-sized frame.
- Images: each room uses its generated plate and each companion uses its transparent sprite sheet. The rail train/city, harbor coastline and rainy canal remain distinct. All six sprites were inspected and their choices exercised. No visible red alpha fringe appeared on the room backgrounds. No CSS illustration replaces the supplied artwork.
- Content: controls describe actual actions. Source provenance and fixture labels remain truthful. The mock's illustrative question is replaced by the fixture's real review content. No rewards, timers or learning-effectiveness claims were added.

## Functional checks

In the browser, the answer draft survived room and companion switches. Hint preserved that draft; Share submitted it. Finish & save required confirmation, displayed the saved result and focused its heading. Setup with one marked topic and a note started the review and focused the first question. Notebook open/close preserved the draft. Source and long history opened with their headings focused, and Back to the question returned to and focused the current exchange. Reduced-motion and hidden-companion preferences worked. All six choices and their previews were present. No browser console errors were observed in the checked flows.

The final code passed `bun run typecheck`, `bun test` with1646 pass,4 todo and0 fail across61 files, `bun run build:app`, and `bun run scripts/preview-ui.ts --build-only`. The independent code review found no additional major behavior regression beyond the layout issues above. The behavior checks were run across the implementation iterations; the final two changes only affect artwork backgrounds and decorative overflow.

## Limits and follow-up polish

- Mobile was checked through a390x844 browser viewport, not a physical iPhone or Android device. Mobile Safari fixed-background behavior remains untested.
- The ordinary question and a long conversation were checked. This is not exhaustive testing of every possible long topic title, localization, zoom level, live voice path or provider failure combination.
- Closing the notebook leaves focus on the document body. Code review confirmed the exact handler predates this diff. It is a known follow-up, not a new regression from these changes.
- P3: the harbor's compact topic heading can wrap to two lines. It remains readable and the diagram control is visible.
- P3: navigation is more detailed than the illustrative mock because it retains history, source, pause and save. A later product pass could consolidate those controls. This does not block the requested removal of opaque page framing.

No project verification skill was found, so this is not a formal pstack shipping verdict. The work remains a draft PR stacked on #128. Do not merge based on this report alone.
