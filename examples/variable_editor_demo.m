%% MATLAB Variable Editor demo data
% Run this section, then double-click a variable in the MATLAB Workspace.

rng(20260722, "twister");

% Small, paged, and large 2-D matrices.
v1 = reshape(1:25, 5, 5);
v2 = rand(51);
v3 = rand(512);

% Three- and four-dimensional arrays exercise the slice navigator.
v4 = reshape(1:64, 4, 4, 4);
v10 = reshape(1:120, 2, 3, 4, 5);

% Scalar and non-scalar structures.
v5 = struct( ...
    'n1', reshape(1:9, 3, 3), ...
    'n2', reshape(101:108, 2, 4));
v6 = struct();
v6(1).a = 1;
v6(2).a = 2;
v6(3).b = 3;
v6(3).c = rand(124);

% Nested structures and mixed cells.
v7 = struct( ...
    'matrix', magic(4), ...
    'tensor', reshape(1:24, 2, 3, 4), ...
    'nested', struct('vector', 11:15, 'logicalMatrix', logical(eye(3))));
v8 = {magic(3), "MATLAB"; true, 1:5};

% Table variable and row names are displayed as grid headers.
v9 = table((1:6)', rand(6, 1), categorical(["A"; "B"; "A"; "C"; "B"; "A"]), ...
    'VariableNames', {'Index', 'Value', 'Group'}, ...
    'RowNames', {'sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5', 'sample-6'});

% Mixed values and a timetable.
v11 = struct( ...
    'text', "Variable Editor", ...
    'characters', 'MATLAB', ...
    'logicalMatrix', logical(eye(4)), ...
    'timestamps', datetime(2026, 7, 22) + days(0:2), ...
    'specialValues', [NaN, Inf, -Inf, pi], ...
    'nested', struct('matrix', pascal(5), 'message', "Open this field"));
sampleTime = datetime(2026, 7, 22, 9, 0, 0) + minutes((0:5)');
v12 = timetable(sampleTime, sin((0:5)' / 2), 'VariableNames', {'Signal'});

updateTick = 0;

%% Automatic update test
% Keep variables open and run only this section repeatedly. Expanded
% structure paths stay open, changed descendants are marked, and higher
% dimensional slices receive a change indicator.

updateTick = updateTick + 1;
v1(1, 1) = 1000 + updateTick;
v4(:, :, 2) = 2000 + updateTick;
v5.n1 = reshape(3001:3009, 3, 3) + updateTick;
v5.n2(1, 1) = 4000 + updateTick;
v6(3).c(1:5, 1:5) = 5000 + updateTick;
v7.matrix(1, 1) = 6000 + updateTick;
v8{1, 1}(1, 1) = 7000 + updateTick;
v9.Value(1) = 8000 + updateTick;
v10(2, 3, 4, 5) = 9000 + updateTick;
v11.nested.matrix(1, 1) = 10000 + updateTick;
v12.Signal(1) = 11000 + updateTick;
