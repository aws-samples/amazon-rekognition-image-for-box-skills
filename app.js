const AWS = require('aws-sdk');
const Axios = require('axios');
const { FilesReader, SkillsWriter, SkillsErrorEnum } = require('skills-kit-library/skills-kit-2.0');

exports.handler = (event, context, callback) => {
  
    //Print event body to console
    console.log(JSON.parse(event.body));
    
    //Initialize Helper Functions from Box Skills Kit
    var filesReader = new FilesReader(event.body); //used to help download the file from Box
    var skillsWriter = new SkillsWriter(filesReader.getFileContext()); //used to help write Skills Cards back to Box
    
    skillsWriter.saveProcessingCard(); //Sends message to Box UI that Skills are being processed

    //Download File from Box
    var localFileName = Date.now().toString() + "_" + filesReader.getFileContext().fileName; //add timestamp to make sure S3 key will be unique, to ensure read-after-write consistency
    console.log(filesReader.getFileContext());
    var boxGetPath = filesReader.getFileContext().fileDownloadURL;

    Axios.get(boxGetPath, { responseType: 'arraybuffer' })
        .then(response => {
            var buffer = new Buffer(response.data, 'binary');

            //Upload File to S3
            var s3 = new AWS.S3();              
                var params = {
                    Bucket: process.env.S3_BUCKET,
                    Key: localFileName,
                    Body: buffer
                };

            s3.upload(params, function(err, data) {
                if (err) {
                    console.log(err);
                } else {
                    console.log("Object uploaded to " + params.Bucket + "/" + params.Key);

                    //AMAZON REKOGNITION CALLS START HERE
                    var rekognition = new AWS.Rekognition({apiVersion: "2016-06-27"});
                    var cards = []; //this array will hold each Skills card created in this function to eventually post to Box
                
                    //Amazon Rekognition - DetectLabels
                    var labelParams = {
                        Image: {
                            S3Object: {
                                Bucket: process.env.S3_BUCKET,
                                Name: localFileName
                            }
                        },
                        MaxLabels: 50,
                        MinConfidence: 80
                    };
                    console.log(JSON.stringify(labelParams));

                    rekognition.detectLabels(labelParams, function(err, data){
                        if (err) {
                            console.log("ERROR on detectLabels");
                            console.log(err, err.stack);
                        } else {
                            console.log(JSON.stringify(data));
                            
                            if (data.Labels.length > 0){
                                var entries = [];
                                //Loop through the returned labels from Amazon Rekognition and add it to the 'entries' to send to Box
                                for(var i = 0; i < data.Labels.length; i++){
                                    entries.push({
                                        type: 'text',
                                        text: data.Labels[i].Name
                                    });
                                }
                                //Create a Topics Card
                                var keywordLabels = skillsWriter.createTopicsCard(entries, null, "Labels");
                                console.log(keywordLabels);
                                cards.push(keywordLabels);    
                            }
                        }

                        //Amazon Rekognition - DetectText
                        var sharedParams = {
                            Image: {
                                S3Object: {
                                    Bucket: process.env.S3_BUCKET,
                                    Name: localFileName
                                }
                            }
                        };

                        rekognition.detectText(sharedParams, function(err, data){
                            if (err) {
                                console.log("Error on detectText");
                                console.log(err, err.stack);
                            } else {
                                console.log(JSON.stringify(data));
                                
                                if (data.TextDetections.length > 0) {
                                    var entries = [];
                                    //Loop through response data and add to array to be sent to Box
                                    for(var i = 0; i < data.TextDetections.length; i++){
                                        if (!(data.TextDetections[i].ParentId) && data.TextDetections[i].ParentId != 0) { //Avoids repeating each word in a group as a separate entry by only returning parent strings
                                            entries.push({
                                                type: 'text',
                                                text: data.TextDetections[i].DetectedText
                                            });
                                        }
                                    }
                                    //Create a Topics Card
                                    var keywordText = skillsWriter.createTopicsCard(entries, null, "Detected Text");
                                    console.log(keywordText);
                                    cards.push(keywordText);
                                }
                            }

                            //Amazon Rekognition - RecognizeCelebrities
                            //uses same parameter structure as DetectText
                            rekognition.recognizeCelebrities(sharedParams, function(err, data){
                                if (err) {
                                    console.log("ERROR on recognizeCelebrities");
                                    console.log(err, err.stack);
                                } else {
                                    console.log(JSON.stringify(data));
                                    
                                    if (data.CelebrityFaces.length > 0) {
                                        var entries = [];
                                        //Loop through response data and add to array to be sent to Box
                                        for(var i = 0; i < data.CelebrityFaces.length; i++){
                                            entries.push({
                                                type: 'text',
                                                text: data.CelebrityFaces[i].Name
                                            });
                                        }
                                        //Create a Topics Card
                                        var keywordCeleb = skillsWriter.createTopicsCard(entries, null, "Celebrities");
                                        console.log(keywordCeleb);
                                        cards.push(keywordCeleb);
                                    }
                                }

                                //Amazon Rekognition - DetectModerationLabels
                                var moderationParams = {
                                    Image: {
                                        S3Object: {
                                            Bucket: process.env.S3_BUCKET,
                                            Name: localFileName
                                        }
                                    },
                                    MinConfidence: 80
                                };

                                rekognition.detectModerationLabels(moderationParams, function(err, data){
                                    if (err) {
                                        console.log("ERROR on detectModerationLabels");
                                        console.log(err, err.stack);
                                    } else {
                                        console.log(JSON.stringify(data));
                                        
                                        if(data.ModerationLabels.length > 0) {
                                            var entries = [];
                                            //Loop through the returned moderation labels from Amazon Rekognition and add it to the 'entries' to send to Box
                                            for(var i = 0; i < data.ModerationLabels.length; i++) {
                                                entries.push({
                                                    type: 'text',
                                                    text: data.ModerationLabels[i].Name
                                                });
                                            }
                                            
                                            //Create a Keyword Card
                                            var keywordModeration = skillsWriter.createTopicsCard(entries, null, "Moderation Flags");
                                            console.log(keywordModeration);
                                            cards.push(keywordModeration);
                                        }
                                        
                                        //Save cards to Box Skills
                                        skillsWriter.saveDataCards(cards)
                                            .then(resp => console.log('Skill Cards Posted.'))
                                            .catch(error => {
                                                console.error(`Skill processing failed for file:
                                            ${filesReader.getFileContext().fileId} with error: ${error.message}`);
                                                skillsWriter.saveErrorCard(SkillsErrorEnum.UNKNOWN);
                                              });
                                    }
                                });
                            });
                        });
                    });
                }
            });
            callback(null, { statusCode: 200, body: "Success"});
        })
        .catch(error => {
            console.log(error);
        });
};
