//! User-initiated actions routed from the desktop map (Slice 6).
//!
//! Everything here is a fixed, validated operation: a three-entry opener
//! allowlist and a snapshot-bound, token-gated prune of stale git worktree
//! admin records. No generic command execution is exposed and the shell
//! plugin gets no permission.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const UNSUPPORTED: &str = "unsupported on this platform";
pub const TOKEN_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenKind {
    Terminal,
    Editor,
    Reveal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntrySnapshot {
    pub id: String,
    pub gitdir_bytes: Vec<u8>,
    pub target: String,
    pub dev: u64,
    pub ino: u64,
    pub locked: bool,
    /// Fingerprint of the whole admin record (every file's size, mtime and
    /// identity, plus HEAD bytes) so any change after preview is detected.
    pub tree: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewEntry {
    pub id: String,
    pub line: String,
    pub gitdir_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkippedEntry {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub token: String,
    pub root: String,
    pub common_dir: String,
    pub entries: Vec<PreviewEntry>,
    pub skipped: Vec<SkippedEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Applied {
    pub removed: Vec<String>,
    pub remaining: Vec<String>,
    pub skipped: Vec<String>,
}

struct TokenRecord {
    token: String,
    common_dir: PathBuf,
    snapshots: Vec<EntrySnapshot>,
    issued: Instant,
}

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// One-shot prune confirmations, keyed by canonical main-worktree root.
#[derive(Clone)]
pub struct PruneTokens {
    records: Arc<Mutex<HashMap<PathBuf, TokenRecord>>>,
    ttl: Duration,
    now: Clock,
    counter: Arc<AtomicU64>,
}

impl Default for PruneTokens {
    fn default() -> Self {
        Self::with_clock(TOKEN_TTL, Arc::new(Instant::now))
    }
}

impl PruneTokens {
    pub fn with_clock(ttl: Duration, now: Clock) -> Self {
        PruneTokens {
            records: Arc::new(Mutex::new(HashMap::new())),
            ttl,
            now,
            counter: Arc::new(AtomicU64::new(0)),
        }
    }
}

// ---- IMPL BEGIN
const BUNDLE_EXTS: [&str; 6] = ["app", "bundle", "pkg", "command", "terminal", "workflow"];

fn not_git(raw: &str) -> String {
    format!("not a git working directory: {raw}")
}

/// Syntactic checks only: absolute, non-blank, no control characters.
pub fn check_raw_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("path is empty".into());
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err("path contains a control character".into());
    }
    if !raw.starts_with('/') {
        return Err("path must be absolute".into());
    }
    Ok(PathBuf::from(raw))
}

fn reject_bundle(p: &Path) -> Result<(), String> {
    let ext = p
        .file_name()
        .and_then(|n| Path::new(n).extension())
        .map(|e| e.to_string_lossy().to_ascii_lowercase());
    match ext {
        Some(e) if BUNDLE_EXTS.contains(&e.as_str()) => {
            Err("refusing to open an application bundle or executable".into())
        }
        _ => Ok(()),
    }
}

/// A directory that really is a git working directory (real `.git` dir or a
/// `gitdir: ` pointer file; never a symlinked `.git`). Returns the canonical path.
pub fn validate_repo_dir(raw: &str) -> Result<PathBuf, String> {
    let p = check_raw_path(raw)?;
    reject_bundle(&p)?;
    match fs::metadata(&p) {
        Ok(m) if m.is_dir() => {}
        _ => return Err(not_git(raw)),
    }
    let dotgit = p.join(".git");
    let md = fs::symlink_metadata(&dotgit).map_err(|_| not_git(raw))?;
    if md.file_type().is_symlink() {
        return Err(not_git(raw));
    } else if md.is_dir() {
        let head = fs::symlink_metadata(dotgit.join("HEAD")).map_err(|_| not_git(raw))?;
        if !head.is_file() {
            return Err(not_git(raw));
        }
    } else if md.is_file() {
        let mut buf = Vec::new();
        use std::io::Read;
        fs::File::open(&dotgit)
            .and_then(|f| f.take(4096).read_to_end(&mut buf))
            .map_err(|_| not_git(raw))?;
        let text = String::from_utf8_lossy(&buf);
        match text.strip_prefix("gitdir: ") {
            Some(rest) if !rest.trim().is_empty() => {}
            _ => return Err(not_git(raw)),
        }
    } else {
        return Err(not_git(raw));
    }
    let canon = fs::canonicalize(&p).map_err(|_| not_git(raw))?;
    reject_bundle(&canon)?;
    Ok(canon)
}

/// The fixed opener allowlist. The path is always one unmodified argument.
pub fn open_argv(kind: OpenKind, p: &Path) -> (&'static str, Vec<OsString>) {
    let path = p.as_os_str().to_owned();
    match kind {
        OpenKind::Terminal => ("open", vec!["-a".into(), "Terminal".into(), path]),
        OpenKind::Editor => (
            "open",
            vec!["-b".into(), "com.microsoft.VSCode".into(), path],
        ),
        OpenKind::Reveal => ("open", vec!["-R".into(), path]),
    }
}

pub fn plan_open(
    kind: OpenKind,
    raw: &str,
    macos: bool,
) -> Result<(&'static str, Vec<OsString>), String> {
    let p = validate_repo_dir(raw)?;
    if !macos {
        return Err(UNSUPPORTED.into());
    }
    Ok(open_argv(kind, &p))
}

fn run_open(kind: OpenKind, raw: &str) -> Result<(), String> {
    let (prog, argv) = plan_open(kind, raw, cfg!(target_os = "macos"))?;
    let status = Command::new(prog)
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("could not run {prog}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{prog} exited with {status}"))
    }
}

pub fn git_argv(dir: &Path, args: &[&str]) -> Vec<OsString> {
    let mut v: Vec<OsString> = vec![
        "-c".into(),
        "core.fsmonitor=false".into(),
        "-C".into(),
        dir.as_os_str().to_owned(),
    ];
    v.extend(args.iter().map(OsString::from));
    v
}

pub fn git_env() -> Vec<(&'static str, &'static str)> {
    vec![
        ("LC_ALL", "C"),
        ("LANGUAGE", "C"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_OPTIONAL_LOCKS", "0"),
    ]
}

fn run_git(dir: &Path, args: &[&str]) -> Result<(String, String), String> {
    let mut cmd = Command::new("git");
    cmd.args(git_argv(dir, args))
        .envs(git_env())
        .stdin(Stdio::null());
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
    ] {
        cmd.env_remove(var);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    let so = String::from_utf8_lossy(&out.stdout).into_owned();
    let se = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        return Err(format!("git failed: {}", se.trim()));
    }
    Ok((so, se))
}

/// Dry-run enumeration lines only (`Removing ...`), from both streams.
pub fn parse_prune_output(stdout: &str, stderr: &str) -> Vec<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|l| l.starts_with("Removing "))
        .map(str::to_string)
        .collect()
}

/// The main worktree root for any directory inside a repo or linked worktree.
pub fn resolve_main_root(dir: &Path) -> Result<PathBuf, String> {
    let (out, _) = run_git(
        dir,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--is-bare-repository",
        ],
    )?;
    let mut lines = out.lines();
    let common = lines.next().ok_or("git returned no common dir")?;
    if lines.next().map(str::trim) != Some("false") {
        return Err("bare repositories are not supported".into());
    }
    let common = fs::canonicalize(common).map_err(|e| format!("common dir: {e}"))?;
    if common.file_name().map(|n| n != ".git").unwrap_or(true) {
        return Err("common dir is not a main worktree .git".into());
    }
    if !fs::symlink_metadata(&common)
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Err("common dir is not a plain directory".into());
    }
    common
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "no main root".to_string())
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains(['/', '\\'])
        && !id.chars().any(char::is_control)
}

/// Admin record contents must be plain files, plus the `logs`/`refs` trees git
/// itself creates (plain files and directories only, bounded depth).
fn identity(md: &fs::Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        (md.dev(), md.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = md;
        (0, 0)
    }
}

fn mtime_nanos(md: &fs::Metadata) -> u128 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Admin record contents must be plain files, plus the `logs`/`refs` trees git
/// itself creates (plain files and directories only, bounded depth). Any git
/// lockfile means a git process is mid-write: refuse. Every entry is recorded
/// in `fp` so the confirmation binds to the full administrative state.
fn plain_tree(
    dir: &Path,
    rel: &str,
    depth: u32,
    top: bool,
    fp: &mut Vec<String>,
) -> Result<(), String> {
    if depth > 8 {
        return Err("too deeply nested".into());
    }
    let rd = fs::read_dir(dir).map_err(|e| format!("unreadable: {e}"))?;
    for ent in rd {
        let ent = ent.map_err(|e| format!("unreadable: {e}"))?;
        let md = fs::symlink_metadata(ent.path()).map_err(|e| format!("unreadable: {e}"))?;
        let ft = md.file_type();
        let name = ent.file_name();
        let relp = format!("{rel}/{}", name.to_string_lossy());
        if ft.is_symlink() {
            return Err("contains a symlink".into());
        } else if ft.is_dir() {
            if top && name != "logs" && name != "refs" {
                return Err("contains an unexpected subdirectory".into());
            }
            fp.push(format!("d {relp} {}", mtime_nanos(&md)));
            plain_tree(&ent.path(), &relp, depth + 1, false, fp)?;
        } else if ft.is_file() {
            if name.to_string_lossy().ends_with(".lock") && name != "locked" {
                return Err("a git operation is in progress (lockfile present)".into());
            }
            let (d, i) = identity(&md);
            fp.push(format!(
                "f {relp} {} {} {d} {i}",
                md.len(),
                mtime_nanos(&md)
            ));
            if top && name == "HEAD" {
                let b = fs::read(ent.path()).map_err(|e| format!("unreadable: {e}"))?;
                fp.push(format!("H {}", String::from_utf8_lossy(&b)));
            }
        } else {
            return Err("contains a special file".into());
        }
    }
    Ok(())
}

/// Independent staleness check (does not trust git's diagnostic prose): an
/// admin record is only eligible when its `gitdir` pointer names a path that
/// does not exist, or the pointer is missing/empty. A live worktree is never
/// eligible, and an unlocked record only.
fn eligible(snap: &EntrySnapshot) -> Result<(), String> {
    if snap.locked {
        return Err("entry is locked".into());
    }
    if snap.target.is_empty() {
        return Ok(());
    }
    match fs::symlink_metadata(&snap.target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err("worktree location exists; not stale".into()),
    }
}

/// Identity of one admin record, taken without following symlinks. Err means
/// the entry must be skipped (never deleted).
pub fn snapshot(common: &Path, id: &str) -> Result<EntrySnapshot, String> {
    if !safe_id(id) {
        return Err("unsafe entry name".into());
    }
    let parent = common.join("worktrees");
    let pmd = fs::symlink_metadata(&parent).map_err(|e| format!("worktrees: {e}"))?;
    if !pmd.is_dir() {
        return Err("worktrees is not a plain directory".into());
    }
    let dir = parent.join(id);
    let md = fs::symlink_metadata(&dir).map_err(|e| format!("entry: {e}"))?;
    if md.file_type().is_symlink() {
        return Err("entry is a symlink".into());
    }
    if !md.is_dir() {
        return Err("entry is not a directory".into());
    }
    let mut tree = vec![];
    plain_tree(&dir, "", 0, true, &mut tree)?;
    tree.sort();
    let gitdir_bytes = fs::read(dir.join("gitdir")).unwrap_or_default();
    let target = String::from_utf8_lossy(&gitdir_bytes).trim().to_string();
    let locked = fs::symlink_metadata(dir.join("locked")).is_ok();
    let (dev, ino) = identity(&md);
    Ok(EntrySnapshot {
        id: id.to_string(),
        gitdir_bytes,
        target,
        dev,
        ino,
        locked,
        tree,
    })
}

struct Stale {
    id: Result<String, String>, // Err(raw name) when it maps to no admin dir
    line: String,
}

/// `git worktree prune --dry-run --verbose`, mapped onto admin directory ids.
fn enumerate_stale(main: &Path, common: &Path) -> Result<Vec<Stale>, String> {
    let (so, se) = run_git(main, &["worktree", "prune", "--dry-run", "--verbose"])?;
    let lines = parse_prune_output(&so, &se);
    if lines.is_empty() {
        return Ok(vec![]);
    }
    let mut ids = vec![];
    match fs::read_dir(common.join("worktrees")) {
        Ok(rd) => {
            for e in rd.flatten() {
                let name = e.file_name();
                match name.to_str() {
                    Some(n) if !n.chars().any(|c| c.is_control()) => ids.push(n.to_string()),
                    // Ambiguous diagnostics: could be mapped onto another entry.
                    _ => {
                        return Err("an admin entry has an ambiguous name; refusing to prune".into())
                    }
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("worktrees: {e}")),
    }
    let mut out: Vec<Stale> = vec![];
    for line in lines {
        let rest = &line["Removing ".len()..];
        let best = ids
            .iter()
            .filter(|id| rest.starts_with(&format!("worktrees/{id}: ")))
            .max_by_key(|id| id.len());
        let id = match best {
            Some(id) => Ok(id.clone()),
            None => Err(rest.split(": ").next().unwrap_or(rest).to_string()),
        };
        if out.iter().any(|s| s.id == id) {
            continue;
        }
        out.push(Stale { id, line });
    }
    Ok(out)
}

fn display(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

fn root_and_common(root: &str) -> Result<(PathBuf, PathBuf), String> {
    let raw = check_raw_path(root)?;
    let main = resolve_main_root(&raw)?;
    let common = main.join(".git");
    Ok((main, common))
}

impl PruneTokens {
    fn mint(&self) -> String {
        use std::hash::{BuildHasher, Hasher};
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        h.write_u128(nanos);
        h.write_u64(self.counter.fetch_add(1, Ordering::SeqCst));
        h.write_u32(std::process::id());
        let a = h.finish();
        h.write_u64(a);
        format!("{a:016x}{:016x}", h.finish())
    }
}

pub fn prune_preview_impl(tokens: &PruneTokens, root: &str) -> Result<Preview, String> {
    let (main, common) = root_and_common(root)?;
    let mut entries = vec![];
    let mut skipped = vec![];
    let mut snaps = vec![];
    for s in enumerate_stale(&main, &common)? {
        match s.id {
            Err(name) => skipped.push(SkippedEntry {
                id: display(&name),
                reason: "not a recognized admin entry".into(),
            }),
            Ok(id) => match snapshot(&common, &id).and_then(|s| eligible(&s).map(|_| s)) {
                Ok(snap) => {
                    entries.push(PreviewEntry {
                        id: id.clone(),
                        line: display(&s.line),
                        gitdir_path: if snap.target.is_empty() {
                            None
                        } else {
                            Some(display(&snap.target))
                        },
                    });
                    snaps.push(snap);
                }
                Err(reason) => skipped.push(SkippedEntry {
                    id: display(&id),
                    reason,
                }),
            },
        }
    }
    let token = if snaps.is_empty() {
        String::new()
    } else {
        let token = tokens.mint();
        tokens.records.lock().map_err(|_| "poisoned")?.insert(
            main.clone(),
            TokenRecord {
                token: token.clone(),
                common_dir: common.clone(),
                snapshots: snaps,
                issued: (tokens.now)(),
            },
        );
        token
    };
    Ok(Preview {
        token,
        root: main.to_string_lossy().into_owned(),
        common_dir: common.to_string_lossy().into_owned(),
        entries,
        skipped,
    })
}

pub fn prune_apply_impl(tokens: &PruneTokens, root: &str, token: &str) -> Result<Applied, String> {
    let (main, common) = root_and_common(root)?;
    // One-shot: consumed here whatever happens next.
    let rec = tokens
        .records
        .lock()
        .map_err(|_| "poisoned".to_string())?
        .remove(&main)
        .ok_or("no pending prune confirmation for this repository")?;
    if token.is_empty() || rec.token != token {
        return Err("unknown prune confirmation".into());
    }
    if (tokens.now)().saturating_duration_since(rec.issued) > tokens.ttl {
        return Err("prune confirmation expired".into());
    }
    if rec.common_dir != common {
        return Err("repository changed since preview".into());
    }
    if rec.snapshots.is_empty() {
        return Err("nothing to prune".into());
    }
    let current = enumerate_stale(&main, &common)?;
    let confirmed: Vec<&str> = rec.snapshots.iter().map(|s| s.id.as_str()).collect();
    for snap in &rec.snapshots {
        let listed = current
            .iter()
            .any(|c| c.id.as_deref() == Ok(snap.id.as_str()));
        if !listed
            || snapshot(&common, &snap.id).ok().as_ref() != Some(snap)
            || eligible(snap).is_err()
        {
            return Err(format!("entry {} changed since preview", snap.id));
        }
    }
    let skipped: Vec<String> = current
        .iter()
        .filter_map(|c| {
            c.id.clone()
                .ok()
                .or_else(|| Some(display(c.id.as_ref().unwrap_err())))
        })
        .filter(|id| !confirmed.contains(&id.as_str()))
        .collect();
    let (mut removed, mut remaining) = (vec![], vec![]);
    for snap in &rec.snapshots {
        let dir = common.join("worktrees").join(&snap.id);
        // Re-verify immediately before deleting; remove_dir_all never follows
        // symlinks, and we only reach it for a re-verified plain directory.
        if snapshot(&common, &snap.id).ok().as_ref() == Some(snap) && eligible(snap).is_ok() {
            let _ = fs::remove_dir_all(&dir);
        }
        match fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => removed.push(snap.id.clone()),
            _ => remaining.push(snap.id.clone()),
        }
    }
    Ok(Applied {
        removed,
        remaining,
        skipped,
    })
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_path(kind: OpenKind, path: String) -> Result<(), String> {
    blocking(move || run_open(kind, &path)).await
}

#[tauri::command]
pub async fn prune_preview(
    state: tauri::State<'_, PruneTokens>,
    root: String,
) -> Result<Preview, String> {
    let tokens = state.inner().clone();
    blocking(move || prune_preview_impl(&tokens, &root)).await
}

#[tauri::command]
pub async fn prune_apply(
    state: tauri::State<'_, PruneTokens>,
    root: String,
    token: String,
) -> Result<Applied, String> {
    let tokens = state.inner().clone();
    blocking(move || prune_apply_impl(&tokens, &root, &token)).await
}
// ---- IMPL END

#[cfg(test)]
mod safe_id_tests {
    use super::safe_id;

    #[test]
    fn safe_id_rejects_separators_dots_empty_and_controls() {
        for id in ["a\\b", "..", ".", "", "a/b", "a\u{1}b", "a\0b", "a\u{7f}b"] {
            assert!(!safe_id(id), "{id:?} must be rejected");
        }
        assert!(safe_id("feature-1"));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::AtomicUsize;

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    struct TempDir {
        path: PathBuf,
        restore: Vec<PathBuf>,
    }
    impl TempDir {
        fn new() -> Self {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!("afh-actions-{}-{}", std::process::id(), n));
            fs::create_dir_all(&p).unwrap();
            TempDir {
                path: fs::canonicalize(&p).unwrap(),
                restore: vec![],
            }
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            for p in &self.restore {
                let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o755));
            }
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-C"])
            .arg(dir)
            .args(args)
            .output()
            .expect("git on PATH");
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn make_repo(t: &TempDir) -> PathBuf {
        let repo = t.path.join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        repo
    }

    /// Adds a linked worktree `name` beside the repo and deletes its
    /// directory so git considers the admin record stale. Returns the admin dir.
    fn stale_wt(t: &TempDir, repo: &Path, name: &str) -> PathBuf {
        let wt = t.path.join(name);
        git(
            repo,
            &["worktree", "add", "-q", "-b", name, wt.to_str().unwrap()],
        );
        fs::remove_dir_all(&wt).unwrap();
        repo.join(".git/worktrees").join(name)
    }

    fn rs(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    fn tokens_with_offset() -> (PruneTokens, Arc<AtomicU64>) {
        let base = Instant::now();
        let off = Arc::new(AtomicU64::new(0));
        let o = off.clone();
        let t = PruneTokens::with_clock(
            Duration::from_secs(120),
            Arc::new(move || base + Duration::from_secs(o.load(Ordering::SeqCst))),
        );
        (t, off)
    }

    // ---- check_raw_path

    #[test]
    fn check_raw_path_rejects_bad_input() {
        for bad in [
            "",
            "   ",
            "repo",
            "./repo",
            "../x",
            "~/x",
            "/tmp/a\0b",
            "/tmp/a\nb",
            "/tmp/a\rb",
            "/tmp/a\tb",
            "/tmp/a\x1bb",
            "/tmp/a\x7fb",
            " /tmp/x",
        ] {
            assert!(check_raw_path(bad).is_err(), "should reject {bad:?}");
        }
        assert_eq!(check_raw_path("/tmp/x").unwrap(), PathBuf::from("/tmp/x"));
    }

    // ---- validate_repo_dir

    #[test]
    fn validate_repo_dir_accepts_real_repo_and_canonicalizes() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        assert_eq!(validate_repo_dir(rs(&repo)).unwrap(), repo);
        let link = t.path.join("link");
        symlink(&repo, &link).unwrap();
        assert_eq!(validate_repo_dir(rs(&link)).unwrap(), repo);
    }

    #[test]
    fn validate_repo_dir_accepts_gitdir_file() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let wt = t.path.join("linked");
        git(&repo, &["worktree", "add", "-q", "-b", "l", rs(&wt)]);
        assert_eq!(validate_repo_dir(rs(&wt)).unwrap(), wt);
    }

    #[test]
    fn validate_repo_dir_rejects_non_repos() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let empty = t.path.join("emptyfile");
        fs::create_dir(&empty).unwrap();
        fs::write(empty.join(".git"), "").unwrap();
        let bad = t.path.join("badfile");
        fs::create_dir(&bad).unwrap();
        fs::write(bad.join(".git"), "nonsense").unwrap();
        let sym = t.path.join("symgit");
        fs::create_dir(&sym).unwrap();
        symlink(repo.join(".git"), sym.join(".git")).unwrap();
        let plain = t.path.join("plain");
        fs::create_dir(&plain).unwrap();
        let file = t.path.join("file.txt");
        fs::write(&file, "x").unwrap();
        for p in [empty, bad, sym, plain, file, t.path.join("missing")] {
            let e = validate_repo_dir(rs(&p)).unwrap_err();
            assert!(e.contains("not a git"), "{p:?}: {e}");
        }
    }

    #[test]
    fn validate_repo_dir_rejects_bundles() {
        let t = TempDir::new();
        for name in [
            "x.app",
            "Y.APP",
            "y.bundle",
            "z.pkg",
            "a.command",
            "b.terminal",
            "c.workflow",
        ] {
            let d = t.path.join(name);
            fs::create_dir(&d).unwrap();
            git(&d, &["init", "-q"]);
            assert!(validate_repo_dir(rs(&d)).is_err(), "{name}");
        }
    }

    // ---- open_argv / OpenKind / plan_open

    #[test]
    fn open_argv_is_a_fixed_allowlist() {
        let p = Path::new("/tmp/a b \"q\" $(x); `y`");
        let o = |s: &str| OsString::from(s);
        assert_eq!(
            open_argv(OpenKind::Terminal, p),
            (
                "open",
                vec![o("-a"), o("Terminal"), p.as_os_str().to_owned()]
            )
        );
        assert_eq!(
            open_argv(OpenKind::Editor, p),
            (
                "open",
                vec![o("-b"), o("com.microsoft.VSCode"), p.as_os_str().to_owned()]
            )
        );
        assert_eq!(
            open_argv(OpenKind::Reveal, p),
            ("open", vec![o("-R"), p.as_os_str().to_owned()])
        );
    }

    #[test]
    fn open_kind_deserializes_only_known_values() {
        for (s, k) in [
            ("terminal", OpenKind::Terminal),
            ("editor", OpenKind::Editor),
            ("reveal", OpenKind::Reveal),
        ] {
            let got: OpenKind = serde_json::from_str(&format!("\"{s}\"")).unwrap();
            assert_eq!(got, k);
        }
        for bad in ["default", "bash", "Terminal", ""] {
            assert!(serde_json::from_str::<OpenKind>(&format!("\"{bad}\"")).is_err());
        }
    }

    #[test]
    fn plan_open_orders_validation_before_platform() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        assert_eq!(
            plan_open(OpenKind::Reveal, "relative", false).unwrap_err(),
            plan_open(OpenKind::Reveal, "relative", true).unwrap_err()
        );
        assert_ne!(
            plan_open(OpenKind::Reveal, "relative", false).unwrap_err(),
            UNSUPPORTED
        );
        assert_eq!(
            plan_open(OpenKind::Reveal, rs(&repo), false).unwrap_err(),
            UNSUPPORTED
        );
        let (prog, argv) = plan_open(OpenKind::Reveal, rs(&repo), true).unwrap();
        assert_eq!(prog, "open");
        assert_eq!(argv.last().unwrap(), repo.as_os_str());
    }

    // ---- git builder / parsing

    #[test]
    fn git_builder_pins_environment_and_config() {
        let env = git_env();
        for kv in [
            ("LC_ALL", "C"),
            ("LANGUAGE", "C"),
            ("GIT_TERMINAL_PROMPT", "0"),
        ] {
            assert!(env.contains(&kv), "{kv:?}");
        }
        let argv = git_argv(Path::new("/r"), &["worktree", "prune"]);
        let s: Vec<String> = argv
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let c = s.iter().position(|a| a == "-c").unwrap();
        assert_eq!(s[c + 1], "core.fsmonitor=false");
        assert!(s.windows(2).any(|w| w[0] == "-C" && w[1] == "/r"));
        assert_eq!(&s[s.len() - 2..], ["worktree", "prune"]);
    }

    #[test]
    fn parse_prune_output_keeps_removing_lines_from_both_streams() {
        assert!(parse_prune_output("", "").is_empty());
        let got = parse_prune_output(
            "Removing worktrees/a: x\nnoise\n",
            "  Removing worktrees/b: y  \nother\n",
        );
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|l| l.starts_with("Removing ")));
        assert!(got[1].ends_with('y'));
    }

    // ---- resolve_main_root

    #[test]
    fn resolve_main_root_variants() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        assert_eq!(resolve_main_root(&repo).unwrap(), repo);
        let wt = t.path.join("linked");
        git(&repo, &["worktree", "add", "-q", "-b", "l", rs(&wt)]);
        assert_eq!(resolve_main_root(&wt).unwrap(), repo);
        let sub = repo.join("sub/dir");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(resolve_main_root(&sub).unwrap(), repo);
        let bare = t.path.join("b.git");
        git(&t.path, &["init", "-q", "--bare", rs(&bare)]);
        assert!(resolve_main_root(&bare).is_err());
        let plain = t.path.join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(resolve_main_root(&plain).is_err());
    }

    #[test]
    fn resolve_main_root_rejects_common_dir_not_named_dotgit() {
        let t = TempDir::new();
        let wt = t.path.join("w");
        let gd = t.path.join("elsewhere");
        fs::create_dir(&wt).unwrap();
        git(&wt, &["init", "-q", "--separate-git-dir", rs(&gd)]);
        assert!(resolve_main_root(&wt).is_err());
    }

    // ---- prune

    #[test]
    fn prune_preview_lists_stale_entry_and_apply_removes_only_the_record() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let admin = stale_wt(&t, &repo, "feat");
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0].id, "feat");
        assert!(p.entries[0].line.starts_with("Removing "));
        assert!(p.entries[0]
            .gitdir_path
            .as_deref()
            .unwrap()
            .contains("feat"));
        assert_eq!(p.root, rs(&repo));
        assert_eq!(p.common_dir, rs(&repo.join(".git")));
        assert!(p.skipped.is_empty());
        let a = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert_eq!(a.removed, vec!["feat".to_string()]);
        assert!(a.remaining.is_empty());
        assert!(!admin.exists());
        assert!(repo.exists());
        assert!(git(&repo, &["branch", "--list", "feat"]).contains("feat"));
    }

    #[test]
    fn prune_preview_from_a_linked_worktree_binds_the_main_root() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        stale_wt(&t, &repo, "feat");
        let live = t.path.join("live");
        git(&repo, &["worktree", "add", "-q", "-b", "live", rs(&live)]);
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&live)).unwrap();
        assert_eq!(p.root, rs(&repo));
        assert_eq!(p.entries.len(), 1);
        assert!(prune_apply_impl(&tokens, rs(&repo), &p.token).is_ok());
    }

    #[test]
    fn prune_symlinked_admin_entry_never_followed() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        stale_wt(&t, &repo, "ok");
        let ext = t.path.join("external");
        fs::create_dir(&ext).unwrap();
        fs::write(ext.join("victim"), "v").unwrap();
        let evil = repo.join(".git/worktrees/evil");
        symlink(&ext, &evil).unwrap();
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(
            p.entries.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["ok"]
        );
        assert!(p.skipped.iter().any(|s| s.id == "evil"));
        let a = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert_eq!(a.removed, vec!["ok".to_string()]);
        assert!(fs::symlink_metadata(&evil).is_ok());
        assert!(ext.join("victim").exists());
    }

    #[test]
    fn prune_nested_symlink_or_subdirectory_is_skipped() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        stale_wt(&t, &repo, "ok");
        let a1 = stale_wt(&t, &repo, "withsub");
        fs::create_dir(a1.join("sub")).unwrap();
        let a2 = stale_wt(&t, &repo, "withlink");
        let ext = t.path.join("ext");
        fs::create_dir(&ext).unwrap();
        fs::write(ext.join("victim"), "v").unwrap();
        symlink(&ext, a2.join("link")).unwrap();
        let a3 = stale_wt(&t, &repo, "logslink");
        fs::create_dir_all(a3.join("logs")).unwrap();
        symlink(&ext, a3.join("logs/evil")).unwrap();
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(p.entries.len(), 1);
        let ids: Vec<_> = p.skipped.iter().map(|s| s.id.as_str()).collect();
        for want in ["withsub", "withlink", "logslink"] {
            assert!(ids.contains(&want), "{ids:?}");
        }
        prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert!(a1.exists() && a2.exists() && a3.exists());
        assert!(ext.join("victim").exists());
    }

    #[test]
    fn prune_entry_with_committed_history_is_listed() {
        // Real admin dirs carry logs/ and refs/ once a commit was made.
        let t = TempDir::new();
        let repo = make_repo(&t);
        let wt = t.path.join("busy");
        git(&repo, &["worktree", "add", "-q", "-b", "busy", rs(&wt)]);
        git(&wt, &["commit", "-q", "--allow-empty", "-m", "x"]);
        fs::remove_dir_all(&wt).unwrap();
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(p.entries.len(), 1, "{:?}", p.skipped);
        let a = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert_eq!(a.removed, vec!["busy".to_string()]);
    }

    #[test]
    fn prune_token_rejections() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        stale_wt(&t, &repo, "a");
        let other = t.path.join("other");
        fs::create_dir(&other).unwrap();
        git(&other, &["init", "-q"]);

        // unknown token
        let (tokens, off) = tokens_with_offset();
        assert!(prune_apply_impl(&tokens, rs(&repo), "nope").is_err());
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert!(prune_apply_impl(&tokens, rs(&repo), "nope").is_err());
        // consumed even though the attempt failed
        assert!(prune_apply_impl(&tokens, rs(&repo), &p.token).is_err());

        // wrong root
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert!(prune_apply_impl(&tokens, rs(&other), &p.token).is_err());

        // expired
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        off.fetch_add(121, Ordering::SeqCst);
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("expired"), "{e}");

        // reused
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert!(prune_apply_impl(&tokens, rs(&repo), &p.token).is_err());
    }

    #[test]
    fn prune_apply_refuses_empty_set() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert!(p.entries.is_empty());
        assert!(prune_apply_impl(&tokens, rs(&repo), &p.token).is_err());
    }

    #[test]
    fn prune_token_binds_snapshot() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let admin = stale_wt(&t, &repo, "a");
        let tokens = PruneTokens::default();

        // gitdir rewritten between two missing targets
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        fs::write(admin.join("gitdir"), "/nonexistent/elsewhere/.git\n").unwrap();
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("changed"), "{e}");
        assert!(admin.exists());

        // directory replaced by another with the same name (new inode)
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        let fresh = repo.join(".git/worktrees/a.new");
        fs::create_dir(&fresh).unwrap();
        for f in ["gitdir", "HEAD", "commondir"] {
            fs::copy(admin.join(f), fresh.join(f)).unwrap();
        }
        fs::remove_dir_all(&admin).unwrap();
        fs::rename(&fresh, &admin).unwrap();
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("changed"), "{e}");
        assert!(admin.exists());

        // common dir bound
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        tokens
            .records
            .lock()
            .unwrap()
            .get_mut(&repo)
            .unwrap()
            .common_dir = t.path.join("else/.git");
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("changed"), "{e}");
        assert!(admin.exists());
    }

    #[test]
    fn prune_apply_scope_limited() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let a = stale_wt(&t, &repo, "a");
        // a locked stale entry is not listed at preview time
        let lw = t.path.join("lk");
        git(&repo, &["worktree", "add", "-q", "-b", "lk", rs(&lw)]);
        git(&repo, &["worktree", "lock", rs(&lw)]);
        fs::remove_dir_all(&lw).unwrap();
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(p.entries.len(), 1);
        let b = stale_wt(&t, &repo, "b");
        git(&repo, &["worktree", "unlock", rs(&lw)]);
        let r = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert_eq!(r.removed, vec!["a".to_string()]);
        assert!(r.remaining.is_empty());
        assert!(r.skipped.contains(&"b".to_string()));
        assert!(!a.exists());
        assert!(b.exists());
        assert!(repo.join(".git/worktrees/lk").exists());
    }

    #[test]
    fn prune_apply_refuses_when_a_confirmed_entry_became_locked() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let a = stale_wt(&t, &repo, "a");
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        fs::write(a.join("locked"), "").unwrap();
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("changed"), "{e}");
        assert!(a.exists());
    }

    #[test]
    fn prune_apply_verifies_absence() {
        let mut t = TempDir::new();
        let repo = make_repo(&t);
        let a = stale_wt(&t, &repo, "a");
        let parent = repo.join(".git/worktrees");
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        t.restore.push(parent.clone());
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::File::create(parent.join("probe")).is_ok() {
            eprintln!("skipping: running with privileges that ignore permissions");
            return;
        }
        let r = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert!(r.removed.is_empty());
        assert_eq!(r.remaining, vec!["a".to_string()]);
        assert!(a.exists());
    }

    #[test]
    fn prune_locked_and_renamed() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let wt = t.path.join("lk");
        git(&repo, &["worktree", "add", "-q", "-b", "lk", rs(&wt)]);
        git(&repo, &["worktree", "lock", rs(&wt)]);
        let gone = t.path.join("lk-moved");
        fs::rename(&wt, &gone).unwrap();
        let tokens = PruneTokens::default();
        // locked: never listed
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert!(p.entries.is_empty() && p.skipped.is_empty());
        // renaming the sibling of an unlocked worktree makes it stale (documented)
        let wt2 = t.path.join("ren");
        git(&repo, &["worktree", "add", "-q", "-b", "ren", rs(&wt2)]);
        fs::rename(&wt2, t.path.join("ren-moved")).unwrap();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0].id, "ren");
    }

    #[test]
    fn prune_ambiguous_admin_name_fails_closed() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let live = t.path.join("live");
        git(&repo, &["worktree", "add", "-q", "-b", "live", rs(&live)]);
        let _a = stale_wt(&t, &repo, "a");
        let evil = repo.join(".git/worktrees/live: fake\njunk");
        fs::create_dir_all(&evil).unwrap();
        fs::write(
            evil.join("gitdir"),
            format!("{}/nope/.git\n", t.path.display()),
        )
        .unwrap();
        let tokens = PruneTokens::default();
        assert!(prune_preview_impl(&tokens, rs(&repo)).is_err());
        assert!(repo.join(".git/worktrees/live").exists());
        assert!(live.exists());
    }

    #[test]
    fn prune_never_selects_a_live_worktree() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let live = t.path.join("live");
        git(&repo, &["worktree", "add", "-q", "-b", "live", rs(&live)]);
        let a = stale_wt(&t, &repo, "a");
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert_eq!(p.entries.len(), 1);
        let snap = snapshot(&repo.join(".git"), "live").unwrap();
        assert!(eligible(&snap).is_err());
        prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap();
        assert!(!a.exists());
        assert!(repo.join(".git/worktrees/live").exists());
    }

    #[test]
    fn prune_apply_refuses_when_admin_state_changed() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let a = stale_wt(&t, &repo, "a");
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        fs::write(a.join("index"), b"new staged state").unwrap();
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("changed"), "{e}");
        assert!(a.exists());
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        fs::write(a.join("HEAD"), "0123456789012345678901234567890123456789\n").unwrap();
        assert!(prune_apply_impl(&tokens, rs(&repo), &p.token).is_err());
        assert!(a.exists());
    }

    #[test]
    fn prune_refuses_active_git_lockfile() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let a = stale_wt(&t, &repo, "a");
        fs::write(a.join("index.lock"), "").unwrap();
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        assert!(p.entries.is_empty());
        assert_eq!(p.skipped.len(), 1);
        assert!(a.exists());
    }

    #[test]
    fn prune_apply_refuses_when_worktree_restored() {
        let t = TempDir::new();
        let repo = make_repo(&t);
        let a = stale_wt(&t, &repo, "a");
        let tokens = PruneTokens::default();
        let p = prune_preview_impl(&tokens, rs(&repo)).unwrap();
        // the worktree directory (and its .git pointer) comes back
        let wt = t.path.join("a");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", a.display())).unwrap();
        let e = prune_apply_impl(&tokens, rs(&repo), &p.token).unwrap_err();
        assert!(e.contains("changed"), "{e}");
        assert!(a.exists());
    }

    // ---- capability allowlist

    #[test]
    fn default_capability_allowlist() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let mut got: Vec<String> = v["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().expect("string permission").to_string())
            .collect();
        got.sort();
        let mut want: Vec<String> = [
            "core:default",
            "notification:allow-is-permission-granted",
            "notification:allow-request-permission",
            "notification:allow-notify",
            "allow-open-path",
            "allow-prune-preview",
            "allow-prune-apply",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        want.sort();
        assert_eq!(got, want);
        assert!(got.iter().all(|p| !p.starts_with("shell:")));
    }
}
