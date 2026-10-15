# UI review evidence

Component-level Playwright renders with representative fixture data. “Before” uses component code from `a5c2316` (unchanged in the rebased base `1104761`); “after” uses `030a246`. Desktop was rendered at 1100×680 CSS px; mobile at 390×844 CSS px (2× device scale).

## Desktop tab-list menu

| Before (`a5c2316`) | After (`030a246`) |
|:--:|:--:|
| ![Desktop menu before](desktop-menu-before.png) | ![Desktop menu after](desktop-menu-after.png) |

## Mobile approval card

| Before (`a5c2316`) | After (`030a246`) |
|:--:|:--:|
| <img src="mobile-approval-before.png" width="360" alt="Mobile approval card before" /> | <img src="mobile-approval-after.png" width="360" alt="Mobile approval card after" /> |

## Mobile automatic-review history

| Before (`a5c2316`) | After (`030a246`), compact rows |
|:--:|:--:|
| <img src="mobile-history-before.png" width="360" alt="Expanded mobile review history before" /> | <img src="mobile-history-after.png" width="360" alt="Compact mobile review-history rows after" /> |

Expanded details for one history item remain available on demand:

<img src="mobile-history-detail-after.png" width="390" alt="One mobile review-history item expanded after" />
