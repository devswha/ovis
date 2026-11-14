//! How the inbox looks and which keys it names, taken from the user's herdr configuration as
//! hc-tui reads it: the two screens share one theme and one set of keys.
use hc_tui::chrome::ClientShellConfig;
use hc_tui::chrome::palette::Palette;
use ovis_tui_client::ui::Colors;

pub struct Theme {
    pub colors: Colors,
    /// At this width or under it hc-tui draws its phone layout; the inbox does the same.
    pub narrow_at: u16,
    pub mouse: bool,
    /// The keys that leave hc-tui's screen, as the configuration binds them.
    pub terminal_key: String,
}

pub fn load() -> Theme {
    let path = hc_tui::config::config_path();
    let loaded = hc_tui::config::load(&path);
    let live = loaded.config.live_keybinds();
    let detach = &live.keybinds.detach;
    let terminal_key = match (detach.prefix_rhs_label(), detach.label()) {
        (Some(after_prefix), _) => format!("{} {after_prefix}", live.primary_prefix_label()),
        (None, Some(direct)) => direct,
        (None, None) => "the detach key (unset in your herdr config)".to_owned(),
    };
    let shell = ClientShellConfig::from_config(&loaded.config, None, None, path);
    Theme {
        colors: colors(&shell.palette),
        narrow_at: shell.mobile_width_threshold,
        mouse: shell.mouse_capture,
        terminal_key,
    }
}

fn colors(palette: &Palette) -> Colors {
    Colors {
        text: palette.text,
        dim: palette.overlay1,
        accent: palette.accent,
        needs_you: palette.red,
        working: palette.yellow,
        done: palette.teal,
        idle: palette.green,
        selected: palette.surface0,
        you: palette.green,
        agent: palette.mauve,
    }
}
