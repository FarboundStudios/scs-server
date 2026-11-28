# Changelog

## Unreleased

### Added

- Manage independent instances from the Server Manager. Each instance has its own port, data, settings, scripts, addons, logs and delegated roles.
- Export, download and restore full server packs. Import a pack directly from **Instances** to create a stopped instance with the saved name, the next available local port, and an optional public HTTPS address for the new host. The pack includes shared addon archives, load order, optional slots, supported settings, custom scripts, delegated users, schedules, moderation and branding.
- Publish a per-instance launcher page with a logo, banner, description, formatted HTML and CSS, community links, optional mod slots, collision settings and AI traffic status.
- Allow owners to place approved local and Workshop optional mods among shared addons. Compatible launchers use those slots when the player has enabled the mod in the chosen career and it declares `mp_mod_optional: true`.
- Add a Linux Dockerfile and deployment guide for the Manager and multiple game instances, including aaPanel reverse proxy setup on a Hostinger VPS.

### Changed

- Addon management supports bulk uploads, drag and drop, bulk optional slots and streamed archives up to 8 GiB each.
- New instance restores preserve the destination’s host owner and connection identity. Restoring over an existing instance creates a verified safety backup first.
- The Manager can publish a custom in-game truck dealer name and icon on the supported ETS2 build.

## 1.0.2

- Fix synchronization of freight-job trailers and their loads.
