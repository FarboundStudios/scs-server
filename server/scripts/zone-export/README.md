# Standalone no-collision zone exporter

This separate command-line utility uses TruckLib 0.5.2 (GPL-2.0). Its source is provided here under GPL-2.0; see licenses/TruckLib-LICENSE.txt. The HeavyMP server does not link or import TruckLib: it reads generated JSON. Restore dependencies with .NET 10 SDK before running. No DLL from this utility is injected into ETS2.

Upstream: https://github.com/sk-zk/TruckLib , NuGet 0.5.2 source revision 61b5f656a3494bb2cfc104d3deef01ccf02f7e3a.

From the HeavyMP root:

```
node scripts/generate-ncz.mjs --game-dir "D:/SteamLibrary/steamapps/common/Euro Truck Simulator 2" --manifest maps/manifest.json
```

Omit --manifest for the stock Europe map. For a custom map, keep the SCS files named in its server manifest next to that manifest. Archives are read only, in manifest priority order over stock archives. This scans all cities at once; no city coordinates must be entered manually. Copy the resulting server/assets/no-collision-zones-<revision>.json to the server alongside the program update. Regenerate when map sectors or the game map version change. The server refuses an unmatched catalogue instead of applying stale coordinates.

The current geometry uses closed Light ground polygon loops from each facility's prefab descriptor, transformed and checked against the active map's entrance nodes. Road paths, exit markers and small connector polygons are excluded. Concave outlines remain concave; disconnected areas are not bridged with a convex hull. Unresolved models, uncertain placements and missing ground loops are skipped and counted in coverage rather than replaced by broad circles. The polygons describe the prefab's map ground, not a guaranteed physical cadastral boundary for every possible model. Validate unusual models in game. The server's safety envelopes are only used for overlap release; they do not enlarge these footprint polygons. No map archives or game meshes are redistributed with this utility.
