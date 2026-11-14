//! Keys to what they ask for. Every action is one plain letter, digit or arrow: nothing here
//! needs Alt or a function key, which a phone's keyboard does not have.
use hc_vt::{Action, Key, KeyInput, Mods};
use ovis_tui_client::ui::Intent;

pub fn intent(input: &KeyInput) -> Option<Intent> {
    if input.action == Action::Release {
        return None;
    }
    let held = input.mods.difference(Mods::SHIFT);
    if held == Mods::CTRL {
        return matches!(input.key, Key::Char('c')).then_some(Intent::Quit);
    }
    if !held.is_empty() {
        return None;
    }
    let shifted = input.mods.contains(Mods::SHIFT);
    Some(match input.key {
        Key::ArrowUp | Key::Char('k') => Intent::Up,
        Key::ArrowDown | Key::Char('j') => Intent::Down,
        Key::End | Key::Char('G') => Intent::Bottom,
        Key::Char('g') if shifted => Intent::Bottom,
        Key::Home | Key::Char('g') => Intent::Top,
        Key::Enter | Key::ArrowRight | Key::Char('l' | 'o') => Intent::Open,
        Key::Char('t') => Intent::Terminal,
        Key::Char('d') | Key::PageDown => Intent::ScrollDown,
        Key::Char('u') | Key::PageUp => Intent::ScrollUp,
        Key::Escape | Key::ArrowLeft | Key::Backspace | Key::Char('b' | 'h') => Intent::Back,
        Key::Char(digit @ '1'..='9') => Intent::Answer(u8::try_from(digit.to_digit(10)?).ok()?),
        Key::Char('m') => Intent::MarkRead,
        Key::Char('r') => Intent::Refresh,
        Key::Char('?') => Intent::Help,
        Key::Char('/') if shifted => Intent::Help,
        Key::Char('q') => Intent::Quit,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pressed(key: Key, mods: Mods) -> Option<Intent> {
        intent(&KeyInput {
            key,
            mods,
            action: Action::Press,
        })
    }

    #[test]
    fn every_action_has_a_key_without_alt_or_a_function_key() {
        let plain = [
            (Key::Char('j'), Intent::Down),
            (Key::Char('k'), Intent::Up),
            (Key::Char('g'), Intent::Top),
            (Key::Char('G'), Intent::Bottom),
            (Key::Enter, Intent::Open),
            (Key::Char('t'), Intent::Terminal),
            (Key::Char('d'), Intent::ScrollDown),
            (Key::Char('u'), Intent::ScrollUp),
            (Key::Char('b'), Intent::Back),
            (Key::Char('3'), Intent::Answer(3)),
            (Key::Char('m'), Intent::MarkRead),
            (Key::Char('r'), Intent::Refresh),
            (Key::Char('?'), Intent::Help),
            (Key::Char('q'), Intent::Quit),
        ];
        for (key, wanted) in plain {
            assert_eq!(pressed(key, Mods::NONE), Some(wanted), "{key:?}");
        }
    }

    #[test]
    fn a_key_release_and_a_chord_ask_for_nothing() {
        let release = KeyInput {
            key: Key::Char('1'),
            mods: Mods::NONE,
            action: Action::Release,
        };
        assert_eq!(intent(&release), None);
        assert_eq!(pressed(Key::Char('1'), Mods::ALT), None);
        assert_eq!(pressed(Key::Char('q'), Mods::CTRL), None);
        assert_eq!(pressed(Key::Char('c'), Mods::CTRL), Some(Intent::Quit));
    }
}
