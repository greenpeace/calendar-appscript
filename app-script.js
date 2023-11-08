// Set the ID of the team calendar to add events to. You can find the calendar's
// ID on the settings page.
let TEAM_CALENDAR_ID = 'c_634e4d79151b6c7bb062fe664d7620b94f727bc0bb451cb7b939f1e3f5f2ebee@group.calendar.google.com';
// Set the email address of the Google Group that contains everyone in the team.
// Ensure the group has less than 500 members to avoid timeouts.
let GROUP_EMAIL = 'global-it-unit-group@greenpeace.org';

let KEYWORDS = ['holiday','vacation','on leave','out of office','day off'];
let MONTHS_IN_ADVANCE = 3;

const currentDate = new Date();

function padZero(number) {
  return (number < 10 ? '0' : '') + number;
}

/**
 * Sets up the script to run automatically every hour.
 */
function setup() {
  let triggers = ScriptApp.getProjectTriggers();
  if (triggers.length > 0) {
    throw new Error('Triggers are already setup.');
  }
  ScriptApp.newTrigger('sync').timeBased().everyHours(1).create();
  // Runs the first sync immediately.
  sync();
}

/**
 * Looks through the group members' public calendars and adds any
 * 'vacation' or 'out of office' events to the team calendar.
 */
function sync() {
  // Defines the calendar event date range to search.
  let today = new Date();
  let maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + MONTHS_IN_ADVANCE);

  // Determines the time the the script was last run.
  let lastRun = PropertiesService.getScriptProperties().getProperty('lastRun');
  lastRun = lastRun ? new Date(lastRun) : null;

  // Gets the list of users in the Google Group.
  let users = GroupsApp.getGroupByEmail(GROUP_EMAIL).getUsers();

  // For each user, finds events having one or more of the keywords in the event
  // summary in the specified date range. Imports each of those to the team
  // calendar.
  let count = 0;
  users.forEach(function(user) {
    let username = user.getEmail().split('@')[0];
    KEYWORDS.forEach(function(keyword) {
      let events = findEvents(user, keyword, today, maxDate, lastRun);
      events.forEach(function(event) {
        importEvent(username, event);
        count++;
      }); // End foreach event.
    }); // End foreach keyword.
  }); // End foreach user.

  PropertiesService.getScriptProperties().setProperty('lastRun', today);
  console.log('Imported ' + count + ' events');
}

/**
 * Imports the given event from the user's calendar into the shared team
 * calendar.
 * @param {string} username The team member that is attending the event.
 * @param {Calendar.Event} event The event to import.
 */
function importEvent(username, event) {

  // Convert event times to GMT+2 (CET)
  const convertedStartDate = convertToTargetTimezone(event.start.dateTime, currentDate);
  const convertedEndDate = convertToTargetTimezone(event.end.dateTime,  currentDate);

  event.summary = '[' + username + '] ' + event.summary;
  event.organizer = {
    id: TEAM_CALENDAR_ID,
  };
  event.attendees = [];
  event.start.dateTime = convertedStartDate;
  event.end.dateTime = convertedEndDate;

  console.log('Importing: %s', event.summary);
  try {
    Calendar.Events.import(event, TEAM_CALENDAR_ID);
  } catch (e) {
    console.error('Error attempting to import event: %s. Skipping.',
        e.toString());
  }
}

/**
 * Converts a date to the target timezone (GMT+2).
 * @param {Date} date The input date.
 * @returns {Date} The converted date in GMT+2.
 */
function convertToTargetTimezone(dateStr, currentDate) {
  const isDST =
    (currentDate.getMonth() >= 10 && currentDate.getMonth() <= 11) || // October to December (DST)
    (currentDate.getMonth() >= 2 && currentDate.getMonth() <= 9); // March to September (DST)

  // Define the default offset based on whether DST is in effect
  const defaultOffset = isDST ? '+02:00' : '+01:00';

  // Extract the date and time part without the offset
  const dateAndTime = dateStr.substring(0, 19);

  // Combine the date and time with the default offset
  const adjustedDateStr = dateAndTime + defaultOffset;

  return adjustedDateStr;
}

/**
 * In a given user's calendar, looks for occurrences of the given keyword
 * in events within the specified date range and returns any such events
 * found.
 * @param {Session.User} user The user to retrieve events for.
 * @param {string} keyword The keyword to look for.
 * @param {Date} start The starting date of the range to examine.
 * @param {Date} end The ending date of the range to examine.
 * @param {Date} optSince A date indicating the last time this script was run.
 * @return {Calendar.Event[]} An array of calendar events.
 */
function findEvents(user, keyword, start, end, optSince) {
  let params = {
    q: keyword,
    timeMin: formatDateAsRFC3339(start),
    timeMax: formatDateAsRFC3339(end),
    showDeleted: true,
  };
  if (optSince) {
    // This prevents the script from examining events that have not been
    // modified since the specified date (that is, the last time the
    // script was run).
    params.updatedMin = formatDateAsRFC3339(optSince);
  }
  let pageToken = null;
  let events = [];
  do {
    params.pageToken = pageToken;
    let response;
    try {
      response = Calendar.Events.list(user.getEmail(), params);
    } catch (e) {
      console.error('Error retriving events for %s, %s: %s; skipping',
          user, keyword, e.toString());
      continue;
    }
    events = events.concat(response.items.filter(function(item) {
      return shoudImportEvent(user, keyword, item);
    }));
    pageToken = response.nextPageToken;
  } while (pageToken);

  return events;
}

/**
 * Determines if the given event should be imported into the shared team
 * calendar.
 * @param {Session.User} user The user that is attending the event.
 * @param {string} keyword The keyword being searched for.
 * @param {Calendar.Event} event The event being considered.
 * @return {boolean} True if the event should be imported.
 */
function shoudImportEvent(user, keyword, event) {
  // Filters out events where the keyword did not appear in the summary
  // (that is, the keyword appeared in a different field, and are thus
  // is not likely to be relevant).
  if (event.summary.toLowerCase().indexOf(keyword) < 0) {
    return false;
  }
  if (!event.organizer || event.organizer.email == user.getEmail()) {
    // If the user is the creator of the event, always imports it.
    return true;
  }
  // Only imports events the user has accepted.
  if (!event.attendees) return false;
  let matching = event.attendees.filter(function(attendee) {
    return attendee.self;
  });
  return matching.length > 0 && matching[0].responseStatus == 'accepted';
}

/**
 * Returns an RFC3339 formated date String corresponding to the given
 * Date object.
 * @param {Date} date a Date.
 * @return {string} a formatted date string.
 */
function formatDateAsRFC3339(date) {
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd\'T\'HH:mm:ssZ');
}
