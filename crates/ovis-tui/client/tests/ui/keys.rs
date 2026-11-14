use ovis_tui_client::ui::{Event, Intent};
use serde_json::json;

use crate::world::{PHONE, WIDE, World, card, healthy, with};

const ANSWER: &str = "POST /api/pane/prompt/answer";
const CARD: &str = "GET /api/pane/prompt?pane_id=t1";

#[test]
fn a_digit_answers_through_the_answer_route_alone_and_the_card_is_read_again() {
    let site = with(vec![
        (ANSWER, vec![(200, json!({ "ok": true }))]),
        (
            CARD,
            vec![(200, card(json!({}))), (200, json!({ "prompt": null }))],
        ),
    ]);
    let mut world = World::open(&site, WIDE);
    site.asked();
    world.key(Intent::Answer(2));
    let asked = site.asked();
    assert_eq!(
        asked
            .iter()
            .map(|asked| asked.route.as_str())
            .collect::<Vec<_>>(),
        [ANSWER, CARD]
    );
    assert_eq!(
        asked[0].body,
        Some(json!({ "pane_id": "t1", "prompt_id": "p1", "option_index": 1 }))
    );
    assert!(world.state.notice.is_some());
    assert_eq!(world.state.answerable(), 0);
    assert!(!world.shows("2 vitest"));
}

#[test]
fn a_question_that_changed_first_is_not_answered_and_the_new_one_is_shown() {
    let changed = json!({ "error": { "code": "prompt_changed", "message": "The interactive prompt changed." } });
    let other = card(
        json!({ "id": "p2", "question": "Another question?", "options": [{ "label": "only", "description": null }], "custom_option_index": null }),
    );
    let site = with(vec![
        (ANSWER, vec![(409, changed)]),
        (CARD, vec![(200, card(json!({}))), (200, other)]),
    ]);
    let mut world = World::open(&site, WIDE);
    site.asked();
    world.key(Intent::Answer(1));
    assert_eq!(site.posts().len(), 1);
    assert!(world.state.notice.is_some());
    assert!(world.shows("Another question?") && world.shows("1 only"));
}

#[test]
fn a_digit_answers_nothing_while_no_card_is_on_screen() {
    let site = with(vec![(ANSWER, vec![(200, json!({ "ok": true }))])]);
    let mut phone = World::open(&site, PHONE);
    phone.key(Intent::Answer(1));
    let mut wide = World::open(&site, WIDE);
    wide.key(Intent::Help);
    wide.key(Intent::Answer(1));
    wide.key(Intent::Help);
    wide.key(Intent::Down);
    wide.key(Intent::Answer(1));
    assert_eq!(site.posts(), []);
}

#[test]
fn a_card_that_takes_several_picks_or_typed_text_is_left_to_the_terminal() {
    let cases = [
        (card(json!({ "multi_select": true })), 1),
        (
            card(json!({ "steps": [{ "label": "one" }, { "label": "two" }] })),
            1,
        ),
        (card(json!({})), 4),
        (card(json!({ "custom_option_index": 1 })), 2),
    ];
    for (shown, digit) in cases {
        let site = with(vec![
            (ANSWER, vec![(200, json!({ "ok": true }))]),
            (CARD, vec![(200, shown.clone())]),
        ]);
        let mut world = World::open(&site, WIDE);
        world.key(Intent::Answer(digit));
        assert_eq!(site.posts(), [], "{shown} {digit}");
        assert!(world.state.notice.is_some(), "{shown} {digit}");
    }
}

#[test]
fn an_answer_on_its_way_is_not_sent_a_second_time() {
    let site = healthy();
    let mut world = World::open(&site, WIDE);
    let first = world.state.on(Event::Key(Intent::Answer(1)));
    assert_eq!(first.len(), 1);
    assert_eq!(
        world.state.card.as_ref().and_then(|card| card.sending),
        Some(0)
    );
    let second = world.state.on(Event::Key(Intent::Answer(2)));
    assert_eq!(second, []);
    assert!(world.state.notice.is_some());
    assert_eq!(
        world.state.card.as_ref().and_then(|card| card.sending),
        Some(0)
    );
}

#[test]
fn an_answer_the_server_fails_is_not_sent_again() {
    let failed = json!({ "error": { "code": "internal", "message": "boom" } });
    // a second post would be answered: a client that sent it again would see it go through
    let site = with(vec![(
        ANSWER,
        vec![(500, failed), (200, json!({ "ok": true }))],
    )]);
    let mut world = World::open(&site, WIDE);
    site.asked();
    world.key(Intent::Answer(1));
    assert_eq!(site.posts().len(), 1);
    assert!(world.state.notice.is_some());
    assert_eq!(
        world.state.card.as_ref().and_then(|card| card.sending),
        None
    );
    world.on(Event::Net(ovis_tui_client::net::Reply::Live(
        ovis_tui_client::live::LiveEvent::Up,
    )));
    assert_eq!(site.posts(), []);
}
