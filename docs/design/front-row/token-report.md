# Local Claude token report for issue #129

These are the completed implementation and correction runs for the selected three-skin design and desk objects, plus the explicitly listed stopped run. Fresh input combines input_tokens and cache_creation_input_tokens. Cached input is cache_read_input_tokens. Output includes the provider-reported thinking tokens. Repeated cached context is counted each time the provider reports it. These are token totals, not dollar estimates.

| Run | Fresh input | Cached input | Output |
| --- | ---: | ---: | ---: |
| selected | 266,665 | 15,195,245 | 111,004 |
| fullbleed | 162,442 | 4,412,549 | 75,404 |
| overlap | 94,221 | 2,920,116 | 31,585 |
| backdrop | 25,715 | 352,822 | 6,424 |
| scroll | 16,940 | 222,015 | 3,334 |
| room-objects | 206,958 | 9,011,794 | 82,866 |
| desk-openers stopped (skill read access) | 50,114 | 238,044 | 2,545 |
| desk-openers | 90,367 | 1,768,773 | 21,938 |
| desk-position | 21,642 | 352,896 | 5,140 |
| desk-mobile | 21,542 | 196,777 | 3,560 |
| Total | 956,606 | 34,671,031 | 343,800 |

The earlier interrupted ornate-art run was reported separately and is excluded. Image generation and the coordinator/reviewer usage are not included because these local Claude run records do not report them.
