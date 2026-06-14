/**
 * DirectoryService — the employee system of record (a leaf service).
 *
 * Defined with `defineService`: handlers receive a Connectum `ctx`, but this
 * service makes no cross-service calls of its own. It owns an in-memory employee
 * map and returns `Code.NotFound` for an unknown id.
 *
 * @module services/directoryService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { DirectoryService, EmployeeSchema, GetEmployeeResponseSchema } from "#gen/directory/v1/directory_pb.ts";

/** Seed employees (id → [name, department]). */
const EMPLOYEES: ReadonlyArray<readonly [string, readonly [string, string]]> = [
    ["e-001", ["Ada Lovelace", "Engineering"]],
    ["e-002", ["Grace Hopper", "Engineering"]],
    ["e-003", ["Katherine Johnson", "Finance"]],
];

/** Demo employee directory (id → Employee fields). */
const employees = new Map<string, { name: string; department: string }>(EMPLOYEES.map(([id, [name, department]]) => [id, { name, department }]));

export const directoryService = defineService(DirectoryService, {
    getEmployee: (req) => {
        const employee = employees.get(req.id);
        if (employee === undefined) {
            throw new ConnectError(`No employee with id "${req.id}".`, Code.NotFound);
        }
        return create(GetEmployeeResponseSchema, {
            employee: create(EmployeeSchema, { id: req.id, name: employee.name, department: employee.department }),
        });
    },
});
