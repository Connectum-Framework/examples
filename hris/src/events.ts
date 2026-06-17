/**
 * Event-topology constants.
 *
 * `LEAVE_APPROVED_TOPIC` is the single source of truth for the topic that
 * `TimeOffService` publishes and `PayrollEventHandlers` subscribes to. It must
 * match the `(connectum.events.v1.event).topic` option on
 * `PayrollEventHandlers.OnLeaveApproved` in `proto/payroll/v1/payroll.proto`.
 *
 * The publisher passes this topic explicitly (`publish(..., { topic })`) rather
 * than relying on the bus's publish-topic lookup: that lookup is built only from
 * registered *subscriber* routes, which the publisher process does not have in
 * split mode.
 *
 * @module events
 */

/** Topic for the LeaveApproved integration event. */
export const LEAVE_APPROVED_TOPIC = "timeoff.leave-approved";
