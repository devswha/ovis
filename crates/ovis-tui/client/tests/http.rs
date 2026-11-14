mod common;

use common::Fake;
use ovis_tui_client::api::{
    Answer, AnswerOutcome, ApiError, Client, Presented, SeenFinish, Server,
};
use serde_json::{Value, json};

fn client(fake: &Fake, token: Option<&str>) -> Client {
    Client::new(Server {
        origin: fake.origin.clone(),
        token: token.map(str::to_owned),
    })
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).expect("a JSON body")
}

#[test]
fn session_carries_the_bearer_token_and_decodes_the_snapshot() {
    let snapshot = json!({ "snapshot": { "protocol": 22, "finish_epoch": "e1", "agents": [], "layouts": [],
        "workspaces": [{ "workspace_id": "w1", "label": "api", "number": 1, "active_tab_id": "t" }],
        "tabs": [{ "tab_id": "w1:t1", "workspace_id": "w1", "label": "1", "number": 1 }],
        "panes": [{ "pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1", "terminal_id": "x", "agent_status": "blocked",
                    "agent": "claude", "agent_kind": "permission", "finish_id": 2, "revision": 3 }] } });
    let fake = Fake::serve(vec![(200, snapshot.to_string())]);
    let got = client(&fake, Some("s3cret")).session().expect("session");
    let request = fake.next();
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("GET", "/api/session")
    );
    assert_eq!(request.authorization.as_deref(), Some("Bearer s3cret"));
    assert_eq!(got.finish_epoch.as_deref(), Some("e1"));
    assert_eq!(got.panes[0].agent_kind.as_deref(), Some("permission"));
    assert_eq!(got.panes[0].finish_id, Some(2));
    fake.join();
}

#[test]
fn no_token_sends_no_authorization() {
    let fake = Fake::serve(vec![(200, json!({ "finishes": [] }).to_string())]);
    assert_eq!(client(&fake, None).seen().expect("seen"), Vec::new());
    let request = fake.next();
    assert_eq!(
        (request.path.as_str(), request.authorization),
        ("/api/seen", None)
    );
    fake.join();
}

#[test]
fn health_names_the_runtime_from_herdr_runtime() {
    let cases = [
        (
            json!({ "ok": true, "version": "0.9.0", "herdr": { "version": "1", "protocol": 22, "runtime": "herdr-core" } }),
            Some("herdr-core"),
        ),
        (
            json!({ "ok": true, "herdr": { "version": "1", "protocol": 22 } }),
            Some("herdr"),
        ),
        (json!({ "ok": true }), None),
    ];
    for (body, runtime) in cases {
        let fake = Fake::serve(vec![(200, body.to_string())]);
        let health = client(&fake, None).health().expect("health");
        assert_eq!(fake.next().path, "/api/health");
        assert_eq!(health.runtime.as_deref(), runtime, "{body}");
        fake.join();
    }
}

#[test]
fn prompt_and_conversation_name_the_pane_in_the_query() {
    let prompt = json!({ "prompt": { "id": "p9", "agent": "claude", "kind": "approval", "title": "Bash", "question": "Run it?",
        "body": null, "options": [{ "label": "Yes", "description": null }, { "label": "No", "description": "stop" }],
        "multi_select": false, "custom_option_index": null } });
    let fake = Fake::serve(vec![
        (200, prompt.to_string()),
        (200, json!({ "prompt": null }).to_string()),
        (
            200,
            json!({ "source": "scrollback", "turns": [], "unavailable": "not_found" }).to_string(),
        ),
    ]);
    let api = client(&fake, None);
    let shown = api
        .prompt("w1:p1")
        .expect("prompt")
        .expect("a prompt is up");
    assert_eq!((shown.id.as_str(), shown.options.len()), ("p9", 2));
    assert_eq!(api.prompt("w1:p1").expect("prompt"), None);
    assert_eq!(
        api.conversation("w1:p1").expect("conversation").turns,
        vec![]
    );
    for path in [
        "/api/pane/prompt",
        "/api/pane/prompt",
        "/api/pane/conversation",
    ] {
        let request = fake.next();
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", path)
        );
        assert_eq!(
            request.query,
            vec![("pane_id".to_owned(), "w1:p1".to_owned())]
        );
    }
    fake.join();
}

#[test]
fn an_answer_posts_pane_prompt_and_option_and_reads_the_outcome() {
    let error = |code: &str, message: &str| {
        json!({ "error": { "code": code, "message": message } }).to_string()
    };
    let cases: Vec<((u16, String), Result<AnswerOutcome, ApiError>)> = vec![
        (
            (200, json!({ "ok": true }).to_string()),
            Ok(AnswerOutcome::Sent),
        ),
        (
            (
                409,
                error("prompt_changed", "The interactive prompt changed"),
            ),
            Ok(AnswerOutcome::PromptChanged),
        ),
        (
            (400, error("invalid_answer", "option_index is out of range")),
            Ok(AnswerOutcome::Refused(
                "option_index is out of range".to_owned(),
            )),
        ),
        (
            (409, error("agent_blocked", "busy")),
            Err(ApiError::Status {
                status: 409,
                code: "agent_blocked".to_owned(),
                message: "busy".to_owned(),
            }),
        ),
        (
            (401, error("unauthorized", "token required")),
            Err(ApiError::Unauthorized("token required".to_owned())),
        ),
        (
            (
                403,
                error("other_user", "this PC belongs to another Tailscale user"),
            ),
            Err(ApiError::Unauthorized(
                "this PC belongs to another Tailscale user".to_owned(),
            )),
        ),
        (
            (200, "<html>".to_owned()),
            Err(ApiError::Decode(
                "expected value at line 1 column 1".to_owned(),
            )),
        ),
    ];
    for (answer, expected) in cases {
        let fake = Fake::serve(vec![answer.clone()]);
        let outcome = client(&fake, Some("t")).answer(&Answer {
            pane_id: "w1:p1".to_owned(),
            prompt_id: "p9".to_owned(),
            option_index: 1,
        });
        let request = fake.next();
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("POST", "/api/pane/prompt/answer")
        );
        assert_eq!(request.authorization.as_deref(), Some("Bearer t"));
        assert_eq!(
            json_of(&request.body),
            json!({ "pane_id": "w1:p1", "prompt_id": "p9", "option_index": 1 })
        );
        assert_eq!(outcome, expected, "{answer:?}");
        fake.join();
    }
}

#[test]
fn mark_seen_posts_the_finish_and_how_it_was_presented() {
    let kept = json!({ "pc": "local", "epoch": "e1", "pane": "w1:p1", "id": 4 }).to_string();
    let fake = Fake::serve(vec![(200, kept.clone()), (200, kept)]);
    let finish = SeenFinish {
        pc: "local".to_owned(),
        epoch: "e1".to_owned(),
        pane: "w1:p1".to_owned(),
        id: 4,
        answer: None,
    };
    let client = client(&fake, None);
    client.mark_seen(&finish, Presented::New).expect("posted");
    let request = fake.next();
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/api/seen")
    );
    assert_eq!(
        json_of(&request.body),
        json!({ "pc": "local", "epoch": "e1", "pane": "w1:p1", "id": 4, "presented": "new" })
    );
    client.mark_seen(&finish, Presented::Held).expect("posted");
    assert_eq!(
        json_of(&fake.next().body),
        json!({ "pc": "local", "epoch": "e1", "pane": "w1:p1", "id": 4, "presented": "held" })
    );
    fake.join();
}

#[test]
fn a_closed_port_is_unreachable() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let origin = format!("http://{}", listener.local_addr().expect("address"));
    drop(listener);
    let outcome = Client::new(Server {
        origin,
        token: None,
    })
    .session();
    assert!(
        matches!(outcome, Err(ApiError::Unreachable(_))),
        "{outcome:?}"
    );
}
