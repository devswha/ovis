//! The server's routes as jobs, run one after another off the screen's thread, with the live
//! subscription beside them. Every answer goes to one sink.
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;

use crate::api::{
    Answer, AnswerOutcome, ApiError, Client, Conversation, Health, Presented, Prompt, SeenFinish,
    Server, Snapshot,
};
use crate::live::{Live, LiveEvent};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    Health,
    Session,
    Seen,
    Prompt(String),
    Conversation(String),
    Answer(Answer),
    MarkSeen(SeenFinish, Presented),
}

#[derive(Debug)]
pub enum Reply {
    Live(LiveEvent),
    Health(Result<Health, ApiError>),
    Session(Result<Snapshot, ApiError>),
    Seen(Result<Vec<SeenFinish>, ApiError>),
    Prompt {
        pane_id: String,
        result: Result<Option<Prompt>, ApiError>,
    },
    Conversation {
        pane_id: String,
        result: Result<Conversation, ApiError>,
    },
    Answered {
        answer: Answer,
        result: Result<AnswerOutcome, ApiError>,
    },
    MarkedSeen {
        finish: SeenFinish,
        result: Result<(), ApiError>,
    },
}

/// Called from the worker's thread and from the subscription's.
pub type Sink = Arc<dyn Fn(Reply) + Send + Sync>;

pub struct Net {
    jobs: Sender<Job>,
    live: Live,
    worker: JoinHandle<()>,
}

impl Net {
    #[must_use]
    pub fn start(server: &Server, sink: Sink) -> Net {
        let (jobs, queue) = mpsc::channel::<Job>();
        let client = Client::new(server.clone());
        let answers = Arc::clone(&sink);
        let worker = std::thread::spawn(move || work(&client, &queue, &answers));
        let live = Live::start(
            server.clone(),
            Box::new(move |event| sink(Reply::Live(event))),
        );
        Net { jobs, live, worker }
    }

    pub fn ask(&self, job: Job) {
        // the worker has ended only when the screen has: nothing waits for this answer
        drop(self.jobs.send(job));
    }

    pub fn watch(&self, pane_id: Option<&str>) {
        self.live.watch(pane_id);
    }

    /// Ends both threads and joins them.
    pub fn stop(self) {
        self.live.stop();
        drop(self.jobs);
        if let Err(panic) = self.worker.join() {
            std::panic::resume_unwind(panic);
        }
    }
}

fn work(client: &Client, queue: &Receiver<Job>, sink: &Sink) {
    while let Ok(first) = queue.recv() {
        let mut batch = vec![first];
        batch.extend(queue.try_iter());
        for job in coalesce(batch) {
            sink(perform(client, job));
        }
    }
}

/// Of the reads waiting, only the last of each kind is still wanted: a later one asks for the same
/// thing anew, or for another pane's card after the selection moved on. Answers and read marks are
/// never dropped, and everything kept stays in its order.
fn coalesce(batch: Vec<Job>) -> Vec<Job> {
    let last = |wanted: fn(&Job) -> bool| batch.iter().rposition(wanted);
    let kept = [
        last(|job| matches!(job, Job::Health)),
        last(|job| matches!(job, Job::Session)),
        last(|job| matches!(job, Job::Seen)),
        last(|job| matches!(job, Job::Prompt(_))),
        last(|job| matches!(job, Job::Conversation(_))),
    ];
    batch
        .into_iter()
        .enumerate()
        .filter(|(index, job)| match job {
            Job::Answer(_) | Job::MarkSeen(..) => true,
            Job::Health | Job::Session | Job::Seen | Job::Prompt(_) | Job::Conversation(_) => {
                kept.contains(&Some(*index))
            }
        })
        .map(|(_, job)| job)
        .collect()
}

/// One job, done now on the caller's thread.
#[must_use]
pub fn perform(client: &Client, job: Job) -> Reply {
    match job {
        Job::Health => Reply::Health(client.health()),
        Job::Session => Reply::Session(client.session()),
        Job::Seen => Reply::Seen(client.seen()),
        Job::Prompt(pane_id) => {
            let result = client.prompt(&pane_id);
            Reply::Prompt { pane_id, result }
        }
        Job::Conversation(pane_id) => {
            let result = client.conversation(&pane_id);
            Reply::Conversation { pane_id, result }
        }
        Job::Answer(answer) => {
            let result = client.answer(&answer);
            Reply::Answered { answer, result }
        }
        Job::MarkSeen(finish, presented) => {
            let result = client.mark_seen(&finish, presented);
            Reply::MarkedSeen { finish, result }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(option_index: usize) -> Job {
        Job::Answer(Answer {
            pane_id: "t1".into(),
            prompt_id: "p".into(),
            option_index,
        })
    }

    #[test]
    fn only_the_last_read_of_each_kind_is_kept_and_no_answer_is_dropped() {
        let batch = vec![
            Job::Prompt("t1".into()),
            Job::Conversation("t1".into()),
            answer(0),
            Job::Session,
            Job::Prompt("t2".into()),
            answer(1),
            Job::Session,
            Job::Conversation("t2".into()),
        ];
        assert_eq!(
            coalesce(batch),
            vec![
                answer(0),
                Job::Prompt("t2".into()),
                answer(1),
                Job::Session,
                Job::Conversation("t2".into()),
            ]
        );
    }
}
