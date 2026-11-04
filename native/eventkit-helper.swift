// eventkit-helper
//
// A standalone command line tool that reads and writes Apple Calendar and
// Reminders through EventKit. It is compiled by the companion app with
// /usr/bin/swiftc and run with an argv array (never a shell), and its stdout is
// parsed as JSON by that app. The contract is therefore exact:
//
//   success : one JSON value on stdout, exit 0
//   failure : "Error: <one readable sentence>" on stderr, exit 1
//   misuse  : "Error: <what is wrong and what to type instead>" on stderr, exit 2
//   --help  : the usage text on stdout, exit 0
//
// Nothing here reads stdin, prompts on the terminal, or prints a stack trace.

import Foundation
import EventKit

// MARK: - Failures

/// `usage` becomes exit code 2 (the command line was wrong), `failure` becomes
/// exit code 1 (the command was understood but could not be carried out).
enum HelperError: Error {
    case usage(String)
    case failure(String)
}

// MARK: - Arguments

/// Flags that take no value, which differs per command: `--completed` is a bare
/// switch for `reminders` but carries `yes|no` for `reminder-update`, and
/// `--all-day` is only a switch for `create`. `--help` is accepted anywhere.
func booleanFlags(for command: String) -> Set<String> {
    switch command {
    case "reminders": return ["--completed", "--help"]
    case "create": return ["--all-day", "--help"]
    default: return ["--help"]
    }
}

struct ParsedCommand {
    let name: String
    let flags: [String: String]
}

/// Reads `argv` after the program name: a subcommand followed by `--flag value`
/// pairs. Every value is a single argv element, so titles with spaces arrive
/// whole and are never re-split.
func parseArguments(_ argv: [String]) throws -> ParsedCommand {
    guard let name = argv.first else {
        throw HelperError.usage("I need a command. Run eventkit-helper --help to see the commands.")
    }

    let booleans = booleanFlags(for: name)
    var flags: [String: String] = [:]
    var index = 1
    while index < argv.count {
        let token = argv[index]
        guard token.hasPrefix("--") else {
            throw HelperError.usage("I did not understand \"\(token)\". Every option starts with --.")
        }
        if booleans.contains(token) {
            flags[token] = "true"
            index += 1
        } else {
            guard index + 1 < argv.count else {
                throw HelperError.usage("\(token) needs a value straight after it.")
            }
            flags[token] = argv[index + 1]
            index += 2
        }
    }
    return ParsedCommand(name: name, flags: flags)
}

func rejectUnknownFlags(_ flags: [String: String], allowed: Set<String>, command: String) throws {
    for key in flags.keys.sorted() where !allowed.contains(key) {
        throw HelperError.usage("I do not know the option \"\(key)\" for \(command). Run eventkit-helper --help to see the options.")
    }
}

func requireFlag(_ flags: [String: String], _ name: String, command: String) throws -> String {
    guard let value = flags[name] else {
        throw HelperError.usage("\(command) needs \(name) followed by its value.")
    }
    return value
}

func parseLimit(_ value: String?, defaultValue: Int, cap: Int) throws -> Int {
    guard let value else { return defaultValue }
    guard let number = Int(value), number >= 0 else {
        throw HelperError.usage("--limit needs a whole number, but it was \"\(value)\".")
    }
    return min(number, cap)
}

// MARK: - Dates

struct ParsedDate {
    let date: Date
    /// True when the value was a bare day (`yyyy-MM-dd`) with no time of day.
    let isAllDay: Bool
}

/// `--due none` clears the due date, while leaving `--due` off leaves it alone,
/// so the two cases cannot both be represented by a plain nil.
enum DueChange {
    case clear
    case set(ParsedDate)
}

/// The two accepted local-time formats. `en_US_POSIX` keeps parsing free of the
/// machine's regional settings; the current time zone keeps everything local.
struct DateFormats {
    private let day: DateFormatter
    private let time: DateFormatter

    init() {
        day = DateFormats.make("yyyy-MM-dd")
        time = DateFormats.make("yyyy-MM-dd HH:mm:ss")
    }

    private static func make(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = format
        return formatter
    }

    /// Parses the time format first, then the bare-day format. Round-tripping
    /// the result back through the same format proves the whole string matched,
    /// so a date the format rejects becomes a usage error instead of a guess.
    func parse(_ value: String, label: String) throws -> ParsedDate {
        if let date = time.date(from: value), time.string(from: date) == value {
            return ParsedDate(date: date, isAllDay: false)
        }
        if let date = day.date(from: value), day.string(from: date) == value {
            return ParsedDate(date: date, isAllDay: true)
        }
        throw HelperError.usage("\(label) must look like \"2026-04-30 14:30:00\" or \"2026-04-30\", but it was \"\(value)\".")
    }

    func text(from date: Date) -> String {
        time.string(from: date)
    }
}

func reminderDueDate(_ reminder: EKReminder) -> Date? {
    guard let components = reminder.dueDateComponents else { return nil }
    return Calendar.current.date(from: components)
}

func dateComponents(from parsed: ParsedDate) -> DateComponents {
    var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: parsed.date)
    if parsed.isAllDay {
        components.hour = nil
        components.minute = nil
        components.second = nil
    }
    return components
}

// MARK: - Thread-safe completion results

/// EventKit answers access requests and reminder fetches on its own queue. This
/// small box carries the answer back across the semaphore without sharing a
/// mutable variable between threads.
final class ResultBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ initial: Value) {
        stored = initial
    }

    func set(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
    }

    func get() -> Value {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

// MARK: - Access

func requireAccess(_ store: EKEventStore, for entity: EKEntityType) throws {
    if EKEventStore.authorizationStatus(for: entity) == .fullAccess {
        return
    }

    let granted = requestAccess(store, for: entity)
    guard granted else {
        if entity == .event {
            throw HelperError.failure("macOS has not given this helper access to your Calendar. Open System Settings > Privacy & Security > Calendars and turn it on, then try again.")
        } else {
            throw HelperError.failure("macOS has not given this helper access to your Reminders. Open System Settings > Privacy & Security > Reminders and turn it on, then try again.")
        }
    }
}

/// Why this blocks: the permission dialog only appears while the process is
/// alive, and the completion handler fires on an internal EventKit queue (not on
/// the main thread), so waiting on a semaphore here keeps the process running
/// until the person answers. Letting main return early would make macOS record
/// the request as abandoned, which looks exactly like a denial.
func requestAccess(_ store: EKEventStore, for entity: EKEntityType) -> Bool {
    let answer = ResultBox<Bool>(false)
    let semaphore = DispatchSemaphore(value: 0)
    let handler: (Bool, Error?) -> Void = { granted, _ in
        answer.set(granted)
        semaphore.signal()
    }

    switch entity {
    case .event:
        store.requestFullAccessToEvents(completion: handler)
    case .reminder:
        store.requestFullAccessToReminders(completion: handler)
    @unknown default:
        semaphore.signal()
    }

    semaphore.wait()
    return answer.get()
}

// MARK: - Lookups

func findCalendar(_ store: EKEventStore, title: String, entity: EKEntityType) throws -> EKCalendar {
    let matches = store.calendars(for: entity).filter {
        $0.title.compare(title, options: .caseInsensitive) == .orderedSame
    }
    guard let calendar = matches.first else {
        let noun = entity == .event ? "calendar" : "list"
        throw HelperError.failure("There is no \(noun) called \"\(title)\".")
    }
    return calendar
}

/// Why matching is by title plus a 90-second start window instead of by id: the
/// app only ever has what the owner typed, and an event id is an opaque sync
/// value that can change between reads. A title alone is ambiguous, so the
/// person also gives the start time, and a 90-second window absorbs clock drift
/// while staying narrow enough not to catch a different meeting. When no start
/// time is given the whole event history is searched and a shared title is
/// reported as ambiguous instead of guessed at.
func matchEvents(_ store: EKEventStore, title: String, start: Date?) -> [EKEvent] {
    let windowStart: Date
    let windowEnd: Date
    if let start {
        windowStart = start.addingTimeInterval(-24 * 60 * 60)
        windowEnd = start.addingTimeInterval(24 * 60 * 60)
    } else {
        windowStart = Date.distantPast
        windowEnd = Date.distantFuture
    }
    let predicate = store.predicateForEvents(withStart: windowStart, end: windowEnd, calendars: nil)
    return store.events(matching: predicate).filter { event in
        guard (event.title ?? "").compare(title, options: .caseInsensitive) == .orderedSame else {
            return false
        }
        guard let start else { return true }
        return abs((event.startDate ?? Date()).timeIntervalSince(start)) <= 90
    }
}

func fetchReminders(_ store: EKEventStore, in calendars: [EKCalendar]?) -> [EKReminder] {
    let answer = ResultBox<[EKReminder]>([])
    let semaphore = DispatchSemaphore(value: 0)
    let predicate = store.predicateForReminders(in: calendars)
    _ = store.fetchReminders(matching: predicate) { reminders in
        answer.set(reminders ?? [])
        semaphore.signal()
    }
    semaphore.wait()
    return answer.get()
}

func matchingReminders(_ store: EKEventStore, title: String, list: String?) throws -> [EKReminder] {
    var calendars: [EKCalendar]? = nil
    if let list {
        calendars = [try findCalendar(store, title: list, entity: .reminder)]
    }
    return fetchReminders(store, in: calendars).filter {
        ($0.title ?? "").compare(title, options: .caseInsensitive) == .orderedSame
    }
}

// MARK: - JSON

func readableParticipantStatus(_ status: EKParticipantStatus) -> String {
    switch status {
    case .unknown: return "unknown"
    case .pending: return "no reply"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "maybe"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "in progress"
    @unknown default: return "unknown"
    }
}

func readableRecurrence(_ rule: EKRecurrenceRule, dates: DateFormats) -> String {
    let unit: String
    switch rule.frequency {
    case .daily: unit = "day"
    case .weekly: unit = "week"
    case .monthly: unit = "month"
    case .yearly: unit = "year"
    @unknown default: unit = "period"
    }

    var text = rule.interval <= 1 ? "every \(unit)" : "every \(rule.interval) \(unit)s"
    if let end = rule.recurrenceEnd {
        if let endDate = end.endDate {
            text += ", until \(dates.text(from: endDate))"
        } else if end.occurrenceCount > 0 {
            text += ", \(end.occurrenceCount) times"
        }
    }
    return text
}

func eventJSON(_ event: EKEvent, dates: DateFormats) -> [String: Any] {
    var object: [String: Any] = [
        "id": event.eventIdentifier ?? "",
        "title": event.title ?? "",
        "startDate": dates.text(from: event.startDate ?? Date()),
        "endDate": dates.text(from: event.endDate ?? Date()),
        "calendar": event.calendar?.title ?? "",
        "isAllDay": event.isAllDay,
    ]

    if let notes = event.notes, !notes.isEmpty {
        object["notes"] = notes
    }
    if let location = event.location, !location.isEmpty {
        object["location"] = location
    }
    if let url = event.url?.absoluteString, !url.isEmpty {
        object["url"] = url
    }
    if let attendees = event.attendees, !attendees.isEmpty {
        object["attendees"] = attendees.map { participant -> [String: Any] in
            [
                "name": participant.name ?? "",
                "url": participant.url.absoluteString,
                "status": readableParticipantStatus(participant.participantStatus),
            ]
        }
    }
    if let rules = event.recurrenceRules, !rules.isEmpty {
        object["recurrenceRules"] = rules.map { readableRecurrence($0, dates: dates) }
    }
    return object
}

func reminderJSON(_ reminder: EKReminder, dates: DateFormats) -> [String: Any] {
    var object: [String: Any] = [
        "id": reminder.calendarItemIdentifier,
        "title": reminder.title ?? "",
        "list": reminder.calendar?.title ?? "",
        "isCompleted": reminder.isCompleted,
        "priority": reminder.priority,
    ]

    if let due = reminderDueDate(reminder) {
        object["dueDate"] = dates.text(from: due)
    }
    if let components = reminder.startDateComponents, let start = Calendar.current.date(from: components) {
        object["startDate"] = dates.text(from: start)
    }
    if let completion = reminder.completionDate {
        object["completionDate"] = dates.text(from: completion)
    }
    if let notes = reminder.notes, !notes.isEmpty {
        object["notes"] = notes
    }
    return object
}

// MARK: - Commands

func execute(_ command: ParsedCommand, store: EKEventStore, dates: DateFormats) throws -> Any {
    let flags = command.flags

    switch command.name {
    case "calendars":
        try rejectUnknownFlags(flags, allowed: [], command: command.name)
        try requireAccess(store, for: .event)
        return store.calendars(for: .event)
            .sorted { $0.title < $1.title }
            .map { calendar -> [String: Any] in
                var object: [String: Any] = [
                    "id": calendar.calendarIdentifier,
                    "title": calendar.title,
                ]
                if let source = calendar.source?.title, !source.isEmpty {
                    object["source"] = source
                }
                return object
            }

    case "lists":
        try rejectUnknownFlags(flags, allowed: [], command: command.name)
        try requireAccess(store, for: .reminder)
        return store.calendars(for: .reminder)
            .sorted { $0.title < $1.title }
            .map { calendar -> [String: Any] in
                ["id": calendar.calendarIdentifier, "title": calendar.title]
            }

    case "events":
        try rejectUnknownFlags(flags, allowed: ["--from", "--to", "--calendar", "--limit"], command: command.name)
        let from = try dates.parse(try requireFlag(flags, "--from", command: command.name), label: "--from")
        let to = try dates.parse(try requireFlag(flags, "--to", command: command.name), label: "--to")
        guard to.date > from.date else {
            throw HelperError.usage("--to must be later than --from.")
        }
        let limit = try parseLimit(flags["--limit"], defaultValue: 300, cap: 300)
        try requireAccess(store, for: .event)
        var calendars: [EKCalendar]? = nil
        if let calendarName = flags["--calendar"] {
            calendars = [try findCalendar(store, title: calendarName, entity: .event)]
        }
        let predicate = store.predicateForEvents(withStart: from.date, end: to.date, calendars: calendars)
        let events = store.events(matching: predicate).sorted { ($0.startDate ?? Date()) < ($1.startDate ?? Date()) }
        return Array(events.prefix(limit)).map { eventJSON($0, dates: dates) }

    case "event":
        try rejectUnknownFlags(flags, allowed: ["--id"], command: command.name)
        let identifier = try requireFlag(flags, "--id", command: command.name)
        try requireAccess(store, for: .event)
        guard let event = store.event(withIdentifier: identifier) else {
            throw HelperError.failure("I could not find that event any more.")
        }
        return eventJSON(event, dates: dates)

    case "event-by-title":
        try rejectUnknownFlags(flags, allowed: ["--title", "--start"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        let start: Date? = try flags["--start"].map { try dates.parse($0, label: "--start").date }
        try requireAccess(store, for: .event)
        let matches = matchEvents(store, title: title, start: start)
        guard !matches.isEmpty else {
            throw HelperError.failure("There is no event called \"\(title)\" at that time.")
        }
        guard matches.count == 1 else {
            throw HelperError.failure("More than one event matches \"\(title)\", so nothing was changed.")
        }
        return eventJSON(matches[0], dates: dates)

    case "create":
        try rejectUnknownFlags(flags, allowed: ["--title", "--start", "--end", "--calendar", "--location", "--notes", "--all-day"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        let start = try dates.parse(try requireFlag(flags, "--start", command: command.name), label: "--start")
        let end = try dates.parse(try requireFlag(flags, "--end", command: command.name), label: "--end")
        let isAllDay = flags["--all-day"] != nil

        if isAllDay {
            guard start.isAllDay, end.isAllDay else {
                throw HelperError.usage("With --all-day, --start and --end must be days like \"2026-04-30\".")
            }
        } else {
            guard !start.isAllDay, !end.isAllDay else {
                throw HelperError.usage("Without --all-day, --start and --end must include a time, like \"2026-04-30 14:30:00\".")
            }
        }
        guard end.date > start.date else {
            throw HelperError.usage("The end time must be after the start time.")
        }

        try requireAccess(store, for: .event)
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start.date
        event.endDate = end.date
        event.isAllDay = isAllDay
        if let calendarName = flags["--calendar"] {
            event.calendar = try findCalendar(store, title: calendarName, entity: .event)
        } else if let defaultCalendar = store.defaultCalendarForNewEvents {
            event.calendar = defaultCalendar
        } else {
            throw HelperError.failure("There is no default calendar for new events on this Mac.")
        }
        if let location = flags["--location"] {
            event.location = location
        }
        if let notes = flags["--notes"] {
            event.notes = notes
        }
        do {
            try store.save(event, span: .thisEvent, commit: true)
        } catch {
            throw HelperError.failure("Calendar would not save the new event.")
        }
        return eventJSON(event, dates: dates)

    case "update":
        try rejectUnknownFlags(flags, allowed: ["--title", "--start", "--new-title", "--new-start", "--new-end", "--location", "--notes"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        let start = try dates.parse(try requireFlag(flags, "--start", command: command.name), label: "--start")
        let newStart = try flags["--new-start"].map { try dates.parse($0, label: "--new-start").date }
        let newEnd = try flags["--new-end"].map { try dates.parse($0, label: "--new-end").date }
        try requireAccess(store, for: .event)
        let matches = matchEvents(store, title: title, start: start.date)
        guard !matches.isEmpty else {
            throw HelperError.failure("There is no event called \"\(title)\" near that time.")
        }
        guard matches.count == 1 else {
            throw HelperError.failure("More than one event is called \"\(title)\" near that time, so I did not change anything.")
        }
        let event = matches[0]
        if let rules = event.recurrenceRules, !rules.isEmpty {
            throw HelperError.failure("That event repeats, so I did not change it. Change it in Calendar instead.")
        }

        var changed = false
        if let newTitle = flags["--new-title"] {
            event.title = newTitle
            changed = true
        }
        if let newStart {
            event.startDate = newStart
            changed = true
        }
        if let newEnd {
            event.endDate = newEnd
            changed = true
        }
        if let location = flags["--location"] {
            event.location = location
            changed = true
        }
        if let notes = flags["--notes"] {
            event.notes = notes
            changed = true
        }
        guard (event.endDate ?? Date()) > (event.startDate ?? Date()) else {
            throw HelperError.usage("The end time must be after the start time.")
        }
        if changed {
            do {
                try store.save(event, span: .thisEvent, commit: true)
            } catch {
                throw HelperError.failure("Calendar would not save the change.")
            }
        }
        return eventJSON(event, dates: dates)

    case "delete":
        try rejectUnknownFlags(flags, allowed: ["--title", "--start", "--confirm"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        let start = try dates.parse(try requireFlag(flags, "--start", command: command.name), label: "--start")
        try requireAccess(store, for: .event)
        let matches = matchEvents(store, title: title, start: start.date)
        guard !matches.isEmpty else {
            throw HelperError.failure("There is no event called \"\(title)\" near that time.")
        }
        guard matches.count == 1 else {
            throw HelperError.failure("More than one event is called \"\(title)\" near that time, so I did not change anything.")
        }
        let event = matches[0]
        guard flags["--confirm"] == title else {
            throw HelperError.failure("To delete \"\(title)\" I need --confirm to say exactly \"\(title)\". Nothing was deleted.")
        }
        if let rules = event.recurrenceRules, !rules.isEmpty {
            throw HelperError.failure("That event repeats, so I did not delete it. Delete it in Calendar instead.")
        }
        if let attendees = event.attendees, !attendees.isEmpty {
            throw HelperError.failure("Other people are on that event, so I did not delete it. Delete it in Calendar instead.")
        }
        let snapshot = eventJSON(event, dates: dates)
        do {
            try store.remove(event, span: .thisEvent, commit: true)
        } catch {
            throw HelperError.failure("Calendar would not delete the event.")
        }
        return snapshot

    case "reminders":
        try rejectUnknownFlags(flags, allowed: ["--list", "--limit", "--completed"], command: command.name)
        let limit = try parseLimit(flags["--limit"], defaultValue: 200, cap: 200)
        let onlyCompleted = flags["--completed"] != nil
        try requireAccess(store, for: .reminder)
        var calendars: [EKCalendar]? = nil
        if let listName = flags["--list"] {
            calendars = [try findCalendar(store, title: listName, entity: .reminder)]
        }
        let reminders = fetchReminders(store, in: calendars).filter { $0.isCompleted == onlyCompleted }
        let ordered = reminders.sorted { first, second in
            switch (reminderDueDate(first), reminderDueDate(second)) {
            case let (left?, right?):
                if left != right { return left < right }
                return (first.title ?? "") < (second.title ?? "")
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            case (nil, nil):
                return (first.title ?? "") < (second.title ?? "")
            }
        }
        return Array(ordered.prefix(limit)).map { reminderJSON($0, dates: dates) }

    case "reminder":
        try rejectUnknownFlags(flags, allowed: ["--title", "--list"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        try requireAccess(store, for: .reminder)
        let matches = try matchingReminders(store, title: title, list: flags["--list"])
        guard !matches.isEmpty else {
            throw HelperError.failure("There is no reminder called \"\(title)\".")
        }
        guard matches.count == 1 else {
            throw HelperError.failure("More than one reminder is called \"\(title)\", so I did not change anything.")
        }
        return reminderJSON(matches[0], dates: dates)

    case "reminder-create":
        try rejectUnknownFlags(flags, allowed: ["--title", "--list", "--due", "--notes", "--priority"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        let due = try flags["--due"].map { try dates.parse($0, label: "--due") }
        let priority = try flags["--priority"].map { try parsePriority($0) }
        try requireAccess(store, for: .reminder)
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        if let listName = flags["--list"] {
            reminder.calendar = try findCalendar(store, title: listName, entity: .reminder)
        } else if let defaultList = store.defaultCalendarForNewReminders() {
            reminder.calendar = defaultList
        } else {
            throw HelperError.failure("There is no default list for new reminders on this Mac.")
        }
        if let due {
            reminder.dueDateComponents = dateComponents(from: due)
        }
        if let notes = flags["--notes"] {
            reminder.notes = notes
        }
        if let priority {
            reminder.priority = priority
        }
        do {
            try store.save(reminder, commit: true)
        } catch {
            throw HelperError.failure("Reminders would not save the new reminder.")
        }
        return reminderJSON(reminder, dates: dates)

    case "reminder-update":
        try rejectUnknownFlags(flags, allowed: ["--title", "--list", "--new-title", "--due", "--notes", "--priority", "--completed"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        let dueChange: DueChange? = try flags["--due"].map { text -> DueChange in
            if text.lowercased() == "none" {
                return .clear
            }
            return .set(try dates.parse(text, label: "--due"))
        }
        let priority = try flags["--priority"].map { try parsePriority($0) }
        let completed: Bool? = try flags["--completed"].map { text -> Bool in
            switch text.lowercased() {
            case "yes": return true
            case "no": return false
            default: throw HelperError.usage("--completed must be yes or no, but it was \"\(text)\".")
            }
        }
        try requireAccess(store, for: .reminder)
        let matches = try matchingReminders(store, title: title, list: flags["--list"])
        guard !matches.isEmpty else {
            throw HelperError.failure("There is no reminder called \"\(title)\".")
        }
        guard matches.count == 1 else {
            throw HelperError.failure("More than one reminder is called \"\(title)\", so I did not change anything.")
        }
        let reminder = matches[0]
        if let newTitle = flags["--new-title"] {
            reminder.title = newTitle
        }
        if let dueChange {
            switch dueChange {
            case .clear:
                reminder.dueDateComponents = nil
            case .set(let parsed):
                reminder.dueDateComponents = dateComponents(from: parsed)
            }
        }
        if let notes = flags["--notes"] {
            reminder.notes = notes
        }
        if let priority {
            reminder.priority = priority
        }
        if let completed {
            reminder.isCompleted = completed
            if completed {
                if reminder.completionDate == nil {
                    reminder.completionDate = Date()
                }
            } else {
                reminder.completionDate = nil
            }
        }
        do {
            try store.save(reminder, commit: true)
        } catch {
            throw HelperError.failure("Reminders would not save the change.")
        }
        return reminderJSON(reminder, dates: dates)

    case "reminder-delete":
        try rejectUnknownFlags(flags, allowed: ["--title", "--list", "--confirm"], command: command.name)
        let title = try requireFlag(flags, "--title", command: command.name)
        try requireAccess(store, for: .reminder)
        guard flags["--confirm"] == title else {
            throw HelperError.failure("To delete \"\(title)\" I need --confirm to say exactly \"\(title)\". Nothing was deleted.")
        }
        let matches = try matchingReminders(store, title: title, list: flags["--list"])
        guard !matches.isEmpty else {
            throw HelperError.failure("There is no reminder called \"\(title)\".")
        }
        guard matches.count == 1 else {
            throw HelperError.failure("More than one reminder is called \"\(title)\", so I did not change anything.")
        }
        let reminder = matches[0]
        let snapshot = reminderJSON(reminder, dates: dates)
        do {
            try store.remove(reminder, commit: true)
        } catch {
            throw HelperError.failure("Reminders would not delete the reminder.")
        }
        return snapshot

    default:
        throw HelperError.usage("\"\(command.name)\" is not a command I know. Run eventkit-helper --help to see the commands.")
    }
}

func parsePriority(_ value: String) throws -> Int {
    guard let number = Int(value), (0...9).contains(number) else {
        throw HelperError.usage("--priority must be a whole number from 0 to 9, but it was \"\(value)\".")
    }
    return number
}

// MARK: - Usage

let usageText = """
eventkit-helper - read and write Apple Calendar and Reminders

Usage:
  eventkit-helper <command> [--flag value ...]

Calendar commands:
  calendars
      List every calendar this tool can read.
  events --from DATE --to DATE [--calendar NAME] [--limit N]
      List events in that window, soonest first. Default limit 300, maximum 300.
  event --id ID
      Show one event in full.
  event-by-title --title T [--start S]
      Show the one event with that title, optionally near start time S.
  create --title T --start S --end E [--calendar NAME] [--location L] [--notes N] [--all-day]
      Create an event and print it.
  update --title T --start S [--new-title X] [--new-start S2] [--new-end E2] [--location L] [--notes N]
      Change the one event whose title and start time match.
  delete --title T --start S --confirm T
      Delete the one event whose title and start time match.

Reminder commands:
  lists
      List every reminder list this tool can read.
  reminders [--list NAME] [--limit N] [--completed]
      List reminders, soonest due first. Default limit 200, maximum 200.
  reminder --title T [--list NAME]
      Show the one reminder with that title.
  reminder-create --title T [--list NAME] [--due D] [--notes N] [--priority P]
      Create a reminder and print it. Priority runs from 0 to 9.
  reminder-update --title T [--list NAME] [--new-title X] [--due D] [--notes N] [--priority P] [--completed yes|no]
      Change the one reminder with that title. --due none clears the due date.
  reminder-delete --title T [--list NAME] --confirm T
      Delete the one reminder with that title and print what was removed.

Dates:
  Local time as YYYY-MM-DD HH:mm:ss, or YYYY-MM-DD for a day with no time.
  For create, --start and --end must include a time unless --all-day is given.

Exit codes:
  0 success, 1 the request could not be carried out, 2 the arguments were wrong.
"""

func writeError(_ message: String) {
    let line = "Error: " + message + "\n"
    FileHandle.standardError.write(Data(line.utf8))
}

// MARK: - Entry point

let argv = Array(CommandLine.arguments.dropFirst())

if argv.isEmpty {
    writeError("I need a command. Run eventkit-helper --help to see the commands.")
    exit(2)
}

if argv[0] == "--help" || argv[0] == "help" {
    print(usageText)
    exit(0)
}

do {
    let command = try parseArguments(argv)
    if command.flags["--help"] != nil {
        print(usageText)
        exit(0)
    }

    // One store per run, reused by whichever command was asked for.
    let store = EKEventStore()
    let dates = DateFormats()
    let result = try execute(command, store: store, dates: dates)

    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
} catch let error as HelperError {
    switch error {
    case .usage(let message):
        writeError(message)
        exit(2)
    case .failure(let message):
        writeError(message)
        exit(1)
    }
} catch {
    writeError("Something went wrong inside the calendar helper.")
    exit(1)
}