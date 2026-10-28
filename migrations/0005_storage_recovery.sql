CREATE TABLE storage_probe (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    sequence INTEGER NOT NULL CHECK(sequence IN (0, 1))
);
INSERT INTO storage_probe VALUES(1, 0);
