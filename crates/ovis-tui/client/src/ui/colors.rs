use ratatui::style::Color;

/// The screen's colours by what they say. The program around it fills them from the user's theme;
/// the defaults are the terminal's own sixteen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Colors {
    pub text: Color,
    pub dim: Color,
    pub accent: Color,
    pub needs_you: Color,
    pub working: Color,
    pub done: Color,
    pub idle: Color,
    /// The selected row's background.
    pub selected: Color,
    pub you: Color,
    pub agent: Color,
}

impl Default for Colors {
    fn default() -> Colors {
        Colors {
            text: Color::Reset,
            dim: Color::DarkGray,
            accent: Color::Cyan,
            needs_you: Color::Red,
            working: Color::Yellow,
            done: Color::Cyan,
            idle: Color::Green,
            selected: Color::Blue,
            you: Color::Green,
            agent: Color::Magenta,
        }
    }
}
