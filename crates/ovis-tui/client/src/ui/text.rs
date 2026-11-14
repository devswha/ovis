//! Text from the server (an agent's question, its chat) on its way to the screen: control
//! characters never reach the terminal, and widths are counted in columns, not bytes.
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// `text` with every control character and text-direction override turned into a space: an
/// escape sequence in an agent's words must not reach the terminal that draws them, nor reorder
/// the line it is drawn on.
#[must_use]
pub fn clean(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_control() || is_direction(ch) {
                ' '
            } else {
                ch
            }
        })
        .collect()
}

fn is_direction(ch: char) -> bool {
    matches!(ch, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// `text` cut to `width` columns, ending in an ellipsis when it was cut.
#[must_use]
pub fn fit(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_owned();
    }
    let Some(room) = width.checked_sub(1) else {
        return String::new();
    };
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let wide = ch.width().unwrap_or(0);
        if used + wide > room {
            break;
        }
        out.push(ch);
        used += wide;
    }
    out.push('…');
    out
}

/// `text` cut or padded to exactly `width` columns.
#[must_use]
pub fn cell(text: &str, width: usize) -> String {
    let cut = fit(text, width);
    let pad = width.saturating_sub(cut.width());
    format!("{cut}{}", " ".repeat(pad))
}

/// `text` in lines of at most `width` columns, cleaned, broken at spaces where it can be and
/// inside a word only when the word alone is wider than a line (text without spaces, as in CJK).
#[must_use]
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let paragraph = clean(paragraph);
        let mut line = String::new();
        for word in paragraph.split(' ').filter(|word| !word.is_empty()) {
            let gap = usize::from(!line.is_empty());
            if line.width() + gap + word.width() <= width {
                if gap == 1 {
                    line.push(' ');
                }
                line.push_str(word);
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            line = split_wide(word, width, &mut lines);
        }
        lines.push(line);
    }
    lines
}

/// Pushes the full lines of a word wider than a line and returns what is left of it.
fn split_wide(word: &str, width: usize, lines: &mut Vec<String>) -> String {
    let mut line = String::new();
    for ch in word.chars() {
        if line.width() + ch.width().unwrap_or(0) > width {
            lines.push(std::mem::take(&mut line));
        }
        line.push(ch);
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_escape_sequence_in_an_agents_words_reaches_the_screen_as_spaces() {
        assert_eq!(clean("ok\u{1b}[2J\u{7}done"), "ok [2J done");
    }

    #[test]
    fn a_direction_override_cannot_reorder_the_line() {
        assert_eq!(clean("a\u{202E}cba\u{2066}d\u{200F}"), "a cba d ");
    }

    #[test]
    fn a_cut_counts_columns_so_wide_characters_never_overflow() {
        assert_eq!(fit("질문입니다", 5), "질문…");
        assert_eq!(cell("ab", 4), "ab  ");
        assert_eq!(fit("abc", 0), "");
    }

    #[test]
    fn wrapping_breaks_at_spaces_and_splits_only_what_cannot_fit() {
        assert_eq!(wrap("which test runner", 10), vec!["which test", "runner"]);
        assert_eq!(wrap("어느테스트러너", 6), vec!["어느테", "스트러", "너"]);
        assert_eq!(wrap("a\nb", 10), vec!["a", "b"]);
    }
}
