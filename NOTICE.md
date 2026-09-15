# Attribution

This project implements an evaluator/optimizer loop inspired by the Gauntlet Loop technique popularized by Matt Shumer.

The specific named-bar, separate-builder, harsh-critic, and repeat-until-win framing was informed by the CC BY 4.0 project [robonuggets/gauntlet-loop](https://github.com/robonuggets/gauntlet-loop), authored by Jay E at RoboNuggets and crediting Matt Shumer for the original technique.

The implementation in this repository is original and uses Playwright's `APIRequestContext` as its execution authority.

The optional live example fetches [Damn Vulnerable RESTaurant API Game](https://github.com/theowni/Damn-Vulnerable-RESTaurant-API-Game) by theowni at commit `d32d09972aec7830f5f1d4a5d274cac7aae7eb82`. Its application source and upstream license remain in the separate ignored checkout; they are not bundled into Gauntlet. The example dependency list was exported from that revision’s Poetry lock. Consult the upstream checkout’s `LICENSE` for its terms.
