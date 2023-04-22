const fs = require('fs');
const { parse } = require('csv-parse');
const { stringify } = require("csv-stringify");
const argv = require('minimist')(process.argv.slice(2));

var CONFIG = {};
var nozzleChanges = []; // 4 max for YY1

function csvSafe(str) {
    return str.replace(",", ".").replace("\"", "").replace("'", "");
}

/* Check if nozzle available somewhere */
function isNozzleAvailable(nozzle) {
    for (var i=0; i<CONFIG.head.length; i++) {
        if (CONFIG.head[i] == nozzle) {
            return true;
        }
    }
    for (var i=0; i<CONFIG.changer.length; i++) {
        if (CONFIG.changer[i] == nozzle) {
            return true;
        }
    }
    return false;
}

/* Check if changer has empty spot */
function isEmptyChangerSlotAvailable(n) {
    for (var i=0; i<CONFIG.changer.length; i++) {
        if (CONFIG.changer[i] == 0) {
            return true;
        }
    }
    return false;
}

/* Check if we have all nozzles */
function checkPipelinesValidity(pipelines) {
    Object.keys(pipelines).forEach((key) => {
        if (+key != 99) {
            if (!isNozzleAvailable(key)) {
                console.log("Nozzle " + key + " is not available.");
                process.exit(4);
            }
        }
    });
    if (!isEmptyChangerSlotAvailable()) {
        console.log("Changer must have at least 1 empty slot.");
        process.exit(5);
    }
}

/* Change nozzle before componentId */
function changeNozzle(head, newNozzle, component) {
    console.log("Changing nozzle on the head " + head + " from " + CONFIG.head[head] + " to " + newNozzle + " before component " + component);

    if ( nozzleChanges.length >=4 ) {
        console.log("Unable to change nozzle. 4 changes are used already!");
        process.exit(2);
    }
    var dropIn = -1;
    var pickFrom = -1;
    for (var i=0; i<CONFIG.changer.length; i++) {

        if (dropIn == -1 && CONFIG.changer[i] == 0) {
            dropIn = i;
        }
        if (pickFrom == -1 && CONFIG.changer[i] == newNozzle) {
            pickFrom = i;
        }
    }
    if (dropIn == -1 || pickFrom == -1) {
        console.log("Unable to find nozzle " + newNozzle + " dropIn: " + dropIn + " pickFrom " + pickFrom);
        process.exit(3);
    }

    CONFIG.changer[dropIn] = CONFIG.head[head];
    CONFIG.head[head] = newNozzle;
    CONFIG.changer[pickFrom] = 0;

    nozzleChanges.push({
        component: component,
        head: head,
        drop: dropIn,
        pickup: pickFrom
    });
}


/* Load feeder definitions **/
function loadFeeders(filename) {
    try {
        var data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        // Add empty feeder for missing components
        data.push({ });

        var ret = [];
        // set default feeder values, if they are missing in the json file
        data.forEach(feeder => {
            ret.push(Object.assign({
                id: 0,
                nozzle: 99,
                value: '',
                footprint: '',
                mode: 3,
                speed: 100,
                pickheight: 0.00,
                placeheight: 0.00
            }, feeder));
        });
        return ret;
    } catch (err) {
        console.log("Unable to load feeders!", err);
        process.exit(1);
    }
}

/* Load config */
function loadConfig(filename) {
    try {
        var data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        return Object.assign({
            xoffset: 0,
            yoffset: 0,
            headOffset: [0, 0]
        }, data);
    } catch (err) {
        console.log("Unable to load config!", err);
        process.exit(1);
    }
}

/* From kicad to map TODO: make it taking format from command line */
function convertPart(row) {
    return {
        reference: row[0],
        value: row[1],
        footprint: row[2],
        x : +(+row[3] + CONFIG.xoffset).toFixed(2),
        y : +(+row[4] + CONFIG.yoffset).toFixed(2),
        orientation : +row[5] > 180 ? +row[5] - 180 : +row[5]
    };
}

/* Load from csv to array */
function loadParts(filename) {
    var ret = [];
    return new Promise((resolve, reject) => {
        fs.createReadStream(filename)
            .pipe(parse({ delimiter: ",", from_line: 2 }))
            .on("data", function (row) {
                var tmp = convertPart(row);
                // Skip fiducials
                if (tmp.value.toLowerCase() !== "fiducial") {
                    ret.push(tmp);
                }
            })
            .on("end", () => {
                resolve(ret);
            })
            .on("error", reject);
    });
}

/* Assign feeders from the library and set skip to 1 if not found */
function assignFeedersToParts(parts, feeders) {
    parts.forEach(part => {
            var matchedFeeder = feeders.find(( feeder ) => ((feeder.value.toLowerCase().trim() === part.value.toLowerCase().trim())
                && (feeder.footprint.toLowerCase().trim() === part.footprint.toLowerCase().trim()) ) );
            if (matchedFeeder !== undefined) {
                part.skip = 0;
                part.feeder = matchedFeeder;
            } else {
                part.skip = 1;
                part.feeder = feeders.find(( feeder ) => feeder.id === 0 );
            }
        }
    );
}

/* Sort by nozzle and feeder. Skipped parts get nozzle 99 to push the to the end of the list */
function sortPartsByNozzleAndFeeder(parts) {
    parts.sort((a, b) => {
        // sort by nozzle
        if (a.feeder.nozzle > b.feeder.nozzle) {
            return 1;
        } else if (a.feeder.nozzle < b.feeder.nozzle) {
            return -1;
        } else {
            // sort by feeder
            if (a.feeder.id > b.feeder.id) {
                return 1;
            } else if (a.feeder.id < b.feeder.id) {
                return -1;
            } else {
                return 0;
            }
        }
    });
}

/* Create nozzle pipelines. All sorted now */
function createNozzlePipelines(parts) {
    var pipelines = {};
    parts.forEach(part => {
        var nozzle = part.feeder.nozzle;
        if (pipelines[nozzle] === undefined) {
            pipelines[nozzle] = [];
        }
        pipelines[nozzle].push(part);
    });
    return pipelines;
}

/* Get next component to place for specific nozzle and remove it from pipeline */
function getNextComponetForNozzle(pipelines, nozzle) {
    if ((pipelines[nozzle] === undefined) || (pipelines[nozzle].length == 0)) {
        return undefined;
    }
    var ret = pipelines[nozzle].shift();
    if (pipelines[nozzle].length == 0) {
        delete(pipelines[nozzle]);
    }
    return ret;
}

function getNextNozzles(pipelines, count) {
    var pendingNozzles = Object.keys(pipelines);
    var ret = [];
    for (var pn = 0; pn < pendingNozzles.length; pn++) {
        var requredNozzle = +pendingNozzles[pn];
        if (requredNozzle == 99) {
            break;
        }
        console.log("We need nozzle " + requredNozzle);
        var availableNozzles = 0;
        for (var i = 0; i < CONFIG.changer.length; i++) {
            if (CONFIG.changer[i] == requredNozzle) {
                availableNozzles++;
            }
        }
        console.log("We have " + availableNozzles + " in changer");
        while ((ret.length<count) && (availableNozzles > 0)) {
            ret.push(requredNozzle);
            availableNozzles--;
        }
        if (ret.length == count) {
            break;
        }
    }
    while (ret.length<count) {
        ret.push(0);
    }
    return ret;
}

function partsLeft(pipelines) {
    var ret = 0;
    Object.keys(pipelines).forEach((key) => {
        if (+key != 99) {
            ret += pipelines[key].length;
        }
    });
    return ret;
}

function pipelinesLeft(pipelines) {
    var ret = 0;
    Object.keys(pipelines).forEach((key) => {
        if (+key != 99) {
            ret ++;
        }
    });
    return ret;
}

function processJob(pipelines) {
    var job = [];
    var jobDone = false;
    var component = -1;

    var headComplete = [CONFIG.head[0]==0, CONFIG.head[1]==0];
    var head = 0;
    while (!jobDone) {

        while (head < CONFIG.head.length) {
            if (headComplete[head]) {
                head ++;
                continue;
            }
            var nozzle = CONFIG.head[head];

            var part = getNextComponetForNozzle(pipelines, nozzle);
            if (part !== undefined) {
                component++;
                console.log("#" + component + " > processing head " + head + " with nozzle " + nozzle);
                part.head = head;
                part.skip = 0;
                job.push(part);
                head++; // go to next head
            } else {
                // check now, will we need to change in the future?
                console.log("Pipeline for nozzle " + nozzle + " is empty, lets check next pipeline");
                var pl = partsLeft(pipelines);
                console.log("Parts to place: " + pl);
                if (pl == 0) {
                    jobDone = true;
                    break;
                }

                var nextNozzles = getNextNozzles(pipelines, 1);

                var nozzlesToChangeLeft = nextNozzles.length;

                if (nextNozzles[0] != 0) {
                    changeNozzle(head, nextNozzles[0], component + 1);
                } else {
                    console.log("Disabling head " + head);
                    headComplete[head] = true;
                }
                // restart same head
            }
        } // while heads
        head = 0;
    }

    jobDone = false;
    while (!jobDone) {
        var part = getNextComponetForNozzle(pipelines, 99);
        if (part !== undefined) {
            component++;
            console.log("#" + component + " > will be skipped.");
            part.head = 0;
            part.skip = 1;
            job.push(part);
        } else {
            jobDone = true;
        }
    }

    return job;
}

function exportCSV(job, filename) {
    var empty = ['', '', '', '', '', '', '', '', '', '', '', '', '', '']; // 13!
    const csvStream = fs.createWriteStream(filename);
    const stringifier = stringify({ record_delimiter: "\r\n" });
    stringifier.write(['NEODEN', 'YY1', 'P&P FILE', '', '', '', '', '', '', '', '', '', '', '']);
    stringifier.write(empty);
    stringifier.write(['PanelizedPCB', 'UnitLength', '0', 'UnitWidth', '0', 'Rows', '1', 'Columns', '1', '']);
    stringifier.write(empty);
    stringifier.write(['Fiducial', '1-X', '0', '1-Y', '0', 'OverallOffsetX', '0', 'OverallOffsetY', '0', '']);
    stringifier.write(empty);
    for (var i=0; i<4; i++) {
        if (i<nozzleChanges.length) {
            var c = nozzleChanges[i];
            stringifier.write(['NozzleChange','ON','BeforeComponent',(c.component + 1),'Head'+(c.head + 1),'Drop','Station' + (c.drop + 1),'PickUp','Station' + (c.pickup + 1),'']);
        } else {
            stringifier.write(['NozzleChange','OFF','BeforeComponent','1','Head1','Drop','Station1','PickUp','Station1','']);
        }
    }
    stringifier.write(empty);
    stringifier.write(['Designator','Comment','Footprint','Mid X(mm)','Mid Y(mm) ','Rotation','Head ','FeederNo','Mount Speed(%)','Pick Height(mm)','Place Height(mm)','Mode','Skip']);
    job.forEach(part => {
        stringifier.write([csvSafe(part.reference), csvSafe(part.value), csvSafe(part.footprint), part.x, part.y, part.orientation, part.head + 1, part.feeder.id, part.feeder.speed, part.feeder.pickheight + CONFIG.headOffset[part.head], part.feeder.placeheight + CONFIG.headOffset[part.head], part.feeder.mode, part.skip]);
    });
    stringifier.pipe(csvStream);
}

var feeders = loadFeeders(argv.feeders);
console.log("Loaded " + feeders.length + " feeders.");
CONFIG = loadConfig(argv.config);
console.log("Loaded configuration.");

loadParts(argv.input).then((parts) => {
    assignFeedersToParts(parts, feeders);
    sortPartsByNozzleAndFeeder(parts);
    console.log("Loaded " + parts.length + " parts.");
    var pipelines = createNozzlePipelines(parts);
    checkPipelinesValidity(pipelines);
    var job = processJob(pipelines);
    exportCSV(job, argv.output);
});
